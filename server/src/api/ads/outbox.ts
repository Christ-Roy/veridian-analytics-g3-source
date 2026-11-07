/**
 * Journal de sortie des conversions, et son drain.
 *
 * Deux gestes, et deux seulement : **enregistrer** une conversion à renvoyer à
 * Google, **drainer** ce qui attend. Rien ne part en direct depuis le chemin
 * d'ingestion — si Google tombe ou met dix secondes, la mesure ne s'en aperçoit
 * pas, et une conversion écrite ici finira par partir même après un incident.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 C'est ICI que vivent les règles métier, PAS dans le client réseau
 *
 * `dataManager.ts` ne filtre rien, volontairement : il dit à Google ce qu'on lui
 * demande de dire. La raison tient en une mesure, faite le 2026-08-29 sur le
 * vrai compte ASD : **Google répond HTTP 200 à ce qu'il ne comptera jamais.**
 * Un `gclid` inventé, un événement marqué `CONSENT_DENIED`, un clic vieux de
 * 120 jours : trois 200, zéro conversion. S'en remettre à son filtrage, c'est
 * exporter quand même et croire que ça marche.
 *
 * Les cinq règles, dans l'ordre où elles mordent :
 *
 *  1. **site désactivé** — un site ne renvoie rien tant qu'on ne l'a pas décidé ;
 *  2. **consentement publicitaire** — refusé ou non exprimé, rien ne part ;
 *  3. **âge du clic, 90 jours** — au-delà, Google accepte et ne compte pas ;
 *  4. **mode d'essai** — sur un environnement de recette, seuls les identifiants
 *     préfixés `TEST_` peuvent partir, et en production ils sont les seuls à ne
 *     pas pouvoir partir ;
 *  5. **reprise sur erreur** — définitive contre transitoire, décidée par
 *     `AdsIngestError.retryable`.
 *
 * Les quatre premières produisent un état terminal `skipped` : ce n'est pas une
 * panne, c'est une décision. Les ranger en `failed` ferait monter un compteur
 * d'échecs alors que rien n'est cassé, et enverrait chercher une panne qui
 * n'existe pas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 Le fuseau horaire : le décalage d'une heure qui ne se voit pas
 *
 * `occurred_at` et `click_at` sont des `timestamp` SANS fuseau, et l'API Google
 * exige un RFC 3339 en UTC strict. Mesuré, pas supposé (probe du 2026-08-29) :
 *
 *   - à l'écriture, `'2026-08-29T10:00:00.000Z'::timestamp` donne bien
 *     `10:00:00`. Postgres retient l'heure MURALE du littéral et jette le
 *     fuseau. Écrire avec un `Z` conserve donc l'instant UTC ;
 *     ⚠️ écrire avec un décalage (`…+02:00`) stockerait `10:00:00` au lieu de
 *     `08:00:00`, soit deux heures d'erreur silencieuse. D'où `versColonne()`,
 *     qui n'émet jamais autre chose qu'un `Z` ;
 *   - à la lecture, drizzle (`mode: "string"`) rend `"2026-08-29 10:00:00"`,
 *     **sans `Z`**. Et `new Date("2026-08-29 10:00:00")` est interprété en heure
 *     LOCALE par Node : sur le bastion (Europe/Berlin) cela donne
 *     `08:00:00Z`, deux heures trop tôt. En conteneur UTC, la même ligne est
 *     juste. Le pire des défauts : correct en production, faux en développement,
 *     et faux partout le jour où quelqu'un pose un `TZ`.
 *
 * La convention est donc : **la colonne contient de l'heure murale UTC**, et
 * aucune lecture ne passe par `new Date(valeurDeLaBase)`. On traverse
 * `versColonne()` à l'écriture et `depuisColonne()` à la lecture, deux fonctions
 * pures qui ne consultent jamais le fuseau du processus.
 * `outbox.test.ts` force `process.env.TZ` sur un fuseau décalé : réintroduire un
 * `new Date(...)` nu fait rougir la suite.
 */
import cluster from "node:cluster";
import * as cron from "node-cron";
import { sql } from "drizzle-orm";
import { db as dbParDefaut } from "../../db/postgres/postgres.js";
import { createServiceLogger } from "../../lib/logger/logger.js";
import {
  AdsIngestError,
  formatEventTimestamp,
  ingestConversions,
  pickAdIdentifiers,
  type AdsCredentials,
  type AdsDestination,
  type ConsentStatus,
  type ConversionEvent,
  type IngestOptions,
} from "./dataManager.js";
import { FENETRE_CLIC_JOURS } from "./attribution.js";
import { lireReglages } from "./settings.js";

const logger = createServiceLogger("ads-outbox");

/* ────────────────────────────── Réglages ────────────────────────────────── */

/** États de `ads_conversion_outbox.status`. `skipped` = décidé, pas cassé. */
export const ETAT = {
  enAttente: "pending",
  envoye: "sent",
  echoue: "failed",
  ecarte: "skipped",
} as const;
export type EtatOutbox = (typeof ETAT)[keyof typeof ETAT];

/**
 * Codes de motif posés dans `last_error`. Stables et non traduits : ils sont lus
 * par la page de diagnostic et par les requêtes d'exploitation, où un libellé
 * qui change casserait un filtre sans prévenir.
 *
 * Les cinq premiers mènent à `skipped` — une décision, rien n'est cassé. Les
 * deux derniers mènent à `failed` : on a renoncé, ce qui est une panne.
 *
 * ⚠️ Ils vivent TOUS ici, y compris ceux qui ne servent qu'à un seul endroit.
 * `retry_budget_exhausted` est resté un littéral au milieu d'un gabarit jusqu'au
 * 2026-08-29 : le raisonnement qui justifie les cinq autres valait mot pour mot
 * pour lui, et rien n'aurait signalé une faute de frappe.
 */
export const MOTIF = {
  siteDesactive: "site_disabled",
  consentementRefuse: "consent_denied",
  clicTropVieux: "click_too_old",
  essaiAvecVraiClic: "test_mode_real_click",
  productionAvecClicDEssai: "production_with_test_click",
  /** `failed` : le budget d'essais est épuisé sur une erreur pourtant réessayable. */
  budgetEpuise: "retry_budget_exhausted",
  /** `failed` : la ligne ne peut pas produire un message Data Manager valide. */
  messageImpossible: "unbuildable_event",
} as const;
export type MotifEcart = (typeof MOTIF)[keyof typeof MOTIF];

/** Préfixe des identifiants de clic fabriqués pour la recette. */
export const PREFIXE_ESSAI = "TEST_";

/**
 * Nombre de tentatives avant abandon. Six essais avec le report ci-dessous
 * couvrent un peu plus de douze heures : au-delà, ce n'est plus une coupure,
 * c'est une panne qu'il faut regarder. Continuer indéfiniment ne réparerait
 * rien et masquerait le problème derrière un compteur qui monte.
 */
export const MAX_TENTATIVES = 6;

/** Report exponentiel : 1 min, 2, 4, 8… borné à 6 h. */
export const REPORT_BASE_MS = 60_000;
export const REPORT_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * Durée du bail posé sur une ligne réclamée par un drain.
 *
 * C'est le cœur de la protection contre les drains concurrents, et le choix
 * mérite d'être expliqué. Le motif habituel — ouvrir une transaction,
 * `SELECT … FOR UPDATE SKIP LOCKED`, envoyer, valider — tiendrait la
 * transaction ouverte pendant l'appel HTTP à Google, soit potentiellement des
 * dizaines de secondes de verrou sur une connexion du pool.
 *
 * On réclame donc en UNE écriture courte, qui repousse `next_attempt_at` dans
 * le futur : la ligne devient invisible pour tout autre drain, sans qu'aucun
 * verrou ne survive à la requête. Si le processus meurt en plein envoi, la
 * ligne revient d'elle-même à l'expiration du bail — et un envoi déjà parti ne
 * comptera pas deux fois, puisque le `transactionId` est la clé d'idempotence
 * et que Google déduplique dessus.
 *
 * Dix minutes : bien au-delà du temps d'un envoi (quelques secondes), assez
 * court pour qu'un incident ne bloque pas la file une demi-journée.
 */
export const BAIL_MS = 10 * 60 * 1000;

/** Lignes réclamées par passage. Un lot Data Manager en accepte largement autant. */
export const TAILLE_LOT = 200;

/** Cadence du drain. Une conversion hors ligne n'a aucune urgence à la minute. */
export const CADENCE_DRAIN = "*/2 * * * *";

/* ─────────────────────────── Fuseau horaire ─────────────────────────────── */

/**
 * Format `to_char` qui rend un `timestamp` sans fuseau en RFC 3339 UTC. Les
 * parties entre guillemets sont littérales pour Postgres. Toute lecture
 * d'horodatage de ce module passe par là, faute de quoi le pilote parse la
 * colonne dans le fuseau du processus.
 */
export const FORMAT_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

/**
 * Valeur à écrire dans une colonne `timestamp` sans fuseau.
 *
 * Rend toujours un ISO terminé par `Z`. Ne JAMAIS lui substituer une chaîne
 * portant un décalage : Postgres retient l'heure murale du littéral et jetterait
 * le décalage, décalant la ligne d'autant d'heures, sans erreur.
 */
export function versColonne(instant: Date | string): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`Horodatage illisible : « ${String(instant)} »`);
  }
  return d.toISOString();
}

/**
 * Instant UTC porté par une colonne `timestamp` sans fuseau.
 *
 * On POSE le `Z` au lieu de laisser Node interpréter la chaîne dans le fuseau
 * du processus — c'est toute la différence entre `10:00:00Z` et `08:00:00Z` sur
 * une machine à l'heure de Paris.
 *
 * 🔴 Le cas `Date` est le piège. Un pilote qui parse lui-même la colonne rend un
 * `Date` DÉJÀ décalé du fuseau du processus : `10:00:00` en base devient
 * `14:00:00Z` sous `America/New_York`. Aucune fonction ne peut rattraper cela
 * après coup, l'information est perdue.
 *
 * ⚠️ Ce que ce dépôt fait, et qu'il faut savoir avant de généraliser : drizzle
 * NEUTRALISE ce parser. `postgres-js/driver.cjs` remplace par l'identité les
 * parseurs et sérialiseurs des OID de date, dont 1114, et il mute
 * `client.options`, donc l'objet CLIENT partagé. Comme `postgres.ts` exporte à
 * la fois `db` et le client brut `sql`, le SQL brut du dépôt en bénéficie du
 * seul fait que le module a été importé. Mesuré :
 *
 *     avant drizzle : 2026-08-29 10:00:00 -> Date 2026-08-29T14:00:00.000Z
 *     apres drizzle : 2026-08-29 10:00:00 -> "2026-08-29 10:00:00"
 *
 * Le `to_char` des requêtes de ce module n'est donc PAS ce qui sauve le dépôt,
 * et les autres modules n'ont aucune raison de l'imiter : ils lisent leurs
 * colonnes nues sans risque. Il reste ici pour deux raisons qui tiennent :
 * l'intention est lisible dans la requête, et `BaseOutbox` est un point
 * d'injection — un client qui ne serait jamais passé par `drizzle()`, ou un
 * futur passage à `pg`, rétablirait le parseur d'origine sans prévenir. Le
 * refus ci-dessous est ce qui le rendrait visible.
 */
export function depuisColonne(valeur: string | Date): Date {
  if (valeur instanceof Date) return valeur;

  // `YYYY-MM-DD hh:mm:ss[.ffffff]` → `YYYY-MM-DDThh:mm:ss[.fff]Z`
  const normalise = valeur.trim().replace(" ", "T");
  const avecZ = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(normalise) ? normalise : `${normalise}Z`;
  const d = new Date(avecZ);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`Horodatage de base illisible : « ${String(valeur)} »`);
  }
  return d;
}

/* ─────────────────────────── Règles métier ──────────────────────────────── */

/** Ce que le drain sait d'un site, lu dans `ads_site_settings`. */
export interface ReglagesSite {
  siteId: number;
  customerId: string;
  enabled: boolean;
  testMode: boolean;
}

/** Une ligne du journal, telle que le drain la manipule. */
export interface LigneOutbox {
  id: number;
  siteId: number;
  businessEventId: string;
  conversionActionId: string;
  clickIdType: "gclid" | "gbraid" | "wbraid";
  clickId: string;
  occurredAt: Date;
  /** Instant du CLIC. C'est lui, et non `occurredAt`, que borne la règle des 90 jours. */
  clickAt: Date;
  value: number | null;
  currency: string;
  consentAdUserData: string;
  consentAdPersonalization: string;
  attempts: number;
}

export type Verdict = { envoyer: true } | { envoyer: false; motif: MotifEcart; detail: string };

/**
 * Décide si une ligne a le droit de partir. Fonction PURE : ni base, ni réseau,
 * ni horloge implicite (`maintenant` est un paramètre). C'est ce qui permet de
 * casser chaque règle une par une dans les tests et de voir la suite rougir.
 */
export function evaluerEnvoi(
  ligne: LigneOutbox,
  reglages: ReglagesSite,
  maintenant: Date,
  fenetreJours: number = FENETRE_CLIC_JOURS,
): Verdict {
  // 1. Le site n'a pas été activé. Rien à discuter, et surtout pas de réessai :
  //    l'activation est une décision humaine, pas un incident.
  if (!reglages.enabled) {
    return { envoyer: false, motif: MOTIF.siteDesactive, detail: `site ${reglages.siteId} désactivé` };
  }

  // 2. Consentement publicitaire. `CONSENT_GRANTED` et rien d'autre :
  //    `CONSENT_UNSPECIFIED` n'est pas un accord, c'est une absence de réponse,
  //    et dans l'EEE l'absence de réponse vaut refus. Mesuré : Google répond 200
  //    à un événement `CONSENT_DENIED`, donc le blocage est ici ou nulle part.
  if (ligne.consentAdUserData !== "CONSENT_GRANTED") {
    return {
      envoyer: false,
      motif: MOTIF.consentementRefuse,
      detail: `adUserData=${ligne.consentAdUserData}`,
    };
  }

  // 3. Âge du clic. 🔴 Mesuré le 2026-08-29 sur le vrai compte : une conversion
  //    dont le clic a 120 jours reçoit un **HTTP 200** et ne sera JAMAIS comptée.
  //    Google n'applique pas cette borne à l'envoi. Sans ce contrôle, le journal
  //    afficherait des succès qui ne produisent rien et le compteur d'échecs
  //    resterait à zéro — le motif « répond OK sans rien faire » fabriqué de nos
  //    propres mains.
  //
  //    On borne sur `clickAt` et non sur `occurredAt` : une conversion peut être
  //    enregistrée avec un clic de 88 jours (l'attribution l'autorise), échouer
  //    quelques jours en réessais, et sortir de la fenêtre PENDANT l'attente.
  //    `occurredAt` est toujours postérieur au clic : s'en servir sous-estimerait
  //    l'âge et laisserait passer précisément ces lignes-là.
  const ageJours = (maintenant.getTime() - ligne.clickAt.getTime()) / 86_400_000;
  if (ageJours > fenetreJours) {
    return {
      envoyer: false,
      motif: MOTIF.clicTropVieux,
      detail: `clic vieux de ${ageJours.toFixed(1)} j (limite ${fenetreJours})`,
    };
  }

  // 4. Mode d'essai, dans les DEUX sens. Le raisonnement vient de
  //    `~/site-clients/app-exemple/src/lib/ads-attribution.ts` (ADS_TEST_MODE) :
  //    un environnement de recette porte les identifiants du VRAI compte client,
  //    donc un envoi de test y créerait une vraie conversion attribuée à un vrai
  //    clic — impossible à retirer une fois comptée.
  //
  //    Le sens inverse est gardé aussi, et ce n'est pas de la symétrie
  //    décorative : un `TEST_…` parti en production est un identifiant qui
  //    n'existe pas, donc un 200 sans effet, donc une ligne `sent` qui ment. Il
  //    signale surtout qu'un jeu d'essai a fui dans les données réelles, et cela
  //    doit se voir.
  const estClicDEssai = ligne.clickId.startsWith(PREFIXE_ESSAI);
  if (reglages.testMode && !estClicDEssai) {
    return {
      envoyer: false,
      motif: MOTIF.essaiAvecVraiClic,
      detail: "mode d'essai actif, identifiant de clic réel",
    };
  }
  if (!reglages.testMode && estClicDEssai) {
    return {
      envoyer: false,
      motif: MOTIF.productionAvecClicDEssai,
      detail: "mode d'essai inactif, identifiant de clic de recette",
    };
  }

  return { envoyer: true };
}

/**
 * Report avant la prochaine tentative, en millisecondes. Fonction pure.
 *
 * `tentatives` est le nombre d'essais DÉJÀ consommés, celui qui vient d'échouer
 * compris. Pas de gigue aléatoire : les lots sont réclamés par bail, donc deux
 * drains ne peuvent pas se synchroniser sur les mêmes lignes, et une valeur
 * déterministe se lit dans un test.
 */
export function reportProchaineTentative(tentatives: number): number {
  return Math.min(REPORT_BASE_MS * 2 ** Math.max(0, tentatives - 1), REPORT_MAX_MS);
}

/* ─────────────────────────── Accès à la base ────────────────────────────── */

/**
 * La base, réduite à ce que ce module utilise. Interface plutôt que
 * `typeof db` : les tests branchent un drizzle/PGlite, dont le type ne coïncide
 * pas avec celui du pilote postgres-js.
 */
export interface BaseOutbox {
  execute(requete: unknown): Promise<unknown>;
}

/**
 * ⚠️ Piège de pilote, mesuré : `db.execute()` ne rend PAS la même chose selon le
 * pilote. postgres-js rend directement le tableau de lignes, PGlite rend un
 * objet `{ rows: [...] }`. Un module écrit contre l'un et testé contre l'autre
 * verrait ses tests passer sur des tableaux vides — vert, et faux.
 */
function lignesDe(resultat: unknown): Record<string, unknown>[] {
  if (Array.isArray(resultat)) return resultat as Record<string, unknown>[];
  const rows = (resultat as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function nombreOuNull(valeur: unknown): number | null {
  if (valeur === null || valeur === undefined) return null;
  const n = typeof valeur === "number" ? valeur : Number(valeur);
  return Number.isFinite(n) ? n : null;
}

/**
 * Un horodatage LU EN BASE. Refuse un `Date` — et c'est le point.
 *
 * 🔴 Un pilote qui construit lui-même le `Date` d'une colonne `timestamp` sans
 * fuseau l'a fait dans le fuseau du PROCESSUS : `10:00:00` en base devient
 * `14:00:00Z` sous `America/New_York`. L'information est alors perdue, aucune
 * fonction ne peut la rattraper, et rien ne distingue le résultat d'un instant
 * légitime. La seule issue est de refuser bruyamment.
 *
 * Ce refus ne se déclenche jamais en fonctionnement normal : drizzle neutralise
 * le parseur de l'OID 1114 sur le client partagé, et nos requêtes formatent en
 * plus par `to_char`. Il se déclenchera le jour où l'un des deux disparaît — un
 * client injecté qui n'est pas passé par `drizzle()`, un changement de pilote —
 * et il le fera au premier drain, plutôt qu'après des semaines d'attributions
 * décalées de deux heures que personne n'aurait vues.
 *
 * ⚠️ Le SYMÉTRIQUE est bien plus exposé, et lui n'a pas de filet : drizzle
 * neutralise aussi les SÉRIALISEURS. Une `Date` passée en paramètre n'est donc
 * plus convertie en ISO par le pilote. C'est ce qui rend `versColonne()`
 * obligatoire à l'écriture, et pas seulement soigneux.
 */
function horodatageDeColonne(valeur: unknown, colonne: string): Date {
  if (valeur instanceof Date) {
    throw new TypeError(
      `Colonne « ${colonne} » rendue comme Date par le pilote : le fuseau du processus a déjà été ` +
        `appliqué et l'instant est perdu. La requête doit rendre to_char(${colonne}, '${FORMAT_UTC}').`,
    );
  }
  return depuisColonne(String(valeur));
}

/** Une ligne SQL brute (colonnes en `snake_case`) vers la forme manipulée ici. */
export function versLigne(brute: Record<string, unknown>): LigneOutbox {
  return {
    id: Number(brute.id),
    siteId: Number(brute.site_id),
    businessEventId: String(brute.business_event_id),
    conversionActionId: String(brute.conversion_action_id),
    clickIdType: String(brute.click_id_type) as LigneOutbox["clickIdType"],
    clickId: String(brute.click_id),
    occurredAt: horodatageDeColonne(brute.occurred_at, "occurred_at"),
    clickAt: horodatageDeColonne(brute.click_at, "click_at"),
    value: nombreOuNull(brute.value),
    currency: String(brute.currency ?? "EUR"),
    consentAdUserData: String(brute.consent_ad_user_data),
    consentAdPersonalization: String(brute.consent_ad_personalization),
    attempts: Number(brute.attempts ?? 0),
  };
}

/* ──────────────────────────── Enregistrement ────────────────────────────── */

/**
 * Repli de valeur sur `ads_conversion_mappings`.
 *
 * 🔴 Pourquoi cette fonction existe : une conversion partie à zéro est ACCEPTÉE
 * par Google, COMPTÉE, et fausse le ROAS sans qu'aucun compteur d'erreur ne
 * bouge. C'est le même motif que la fenêtre des 90 jours — un succès qui ne
 * produit pas ce qu'on croit — sauf qu'il traverserait toutes les autres
 * protections du module, qui portent sur l'envoi et pas sur son contenu.
 *
 * Le repli se fait ICI, à l'enregistrement, et pas dans le drain : c'est le seul
 * endroit où l'événement métier est encore connu. Le drain, lui, ne voit qu'un
 * `conversion_action_id`, vers lequel plusieurs événements peuvent pointer.
 *
 * ⚠️ La distinction entre `undefined` et `null` porte du sens et n'est pas un
 * hasard de typage : `undefined` veut dire « je n'ai pas de valeur, cherche le
 * défaut », `null` veut dire « cette conversion n'a légitimement pas de valeur
 * monétaire » — un formulaire de contact, une inscription. Le second ne
 * déclenche aucune recherche.
 *
 * La résolution par `conversionActionId` seul est volontairement conditionnée à
 * l'unicité : la contrainte du dépôt porte sur `(site, event_name)`, donc deux
 * événements PEUVENT viser la même action de conversion avec des valeurs par
 * défaut différentes. Deviner dans ce cas fabriquerait un montant faux et
 * plausible, ce qui est pire que zéro : zéro se voit.
 */
export async function resoudreValeurParDefaut(
  base: BaseOutbox,
  siteId: number,
  reference: { eventName?: string; conversionActionId: string },
): Promise<{ value: number | null; currency: string | null }> {
  const resultat = reference.eventName
    ? await base.execute(sql`
        SELECT default_value, currency FROM ads_conversion_mappings
         WHERE site_id = ${siteId} AND event_name = ${reference.eventName}
         LIMIT 1
      `)
    : await base.execute(sql`
        SELECT default_value, currency FROM ads_conversion_mappings
         WHERE site_id = ${siteId} AND conversion_action_id = ${reference.conversionActionId}
         LIMIT 2
      `);

  const lignes = lignesDe(resultat);
  // Zéro correspondance, ou plusieurs quand on cherchait par action seule :
  // aucun défaut ne peut être invoqué sans deviner.
  if (lignes.length !== 1) return { value: null, currency: null };

  return {
    value: nombreOuNull(lignes[0].default_value),
    currency: lignes[0].currency ? String(lignes[0].currency) : null,
  };
}

export interface ConversionAEnregistrer {
  siteId: number;
  /** Identifiant STABLE de l'événement métier (id de commande…). Il rend le rejeu inoffensif. */
  businessEventId: string;
  conversionActionId: string;
  clickIdType: "gclid" | "gbraid" | "wbraid";
  clickId: string;
  /** Horodatage métier de la conversion. */
  occurredAt: Date | string;
  /** Instant du clic, rendu par `attribution.ts` (`IdentifiantClic.horodatage`). */
  clickAt: Date | string;
  /**
   * Nom de l'événement métier (`order_paid`, `signup`…). Facultatif, mais c'est
   * la SEULE clé qui désigne une correspondance sans ambiguïté : la fournir
   * rend le repli de valeur fiable. Sans elle, le repli n'a lieu que si une
   * seule correspondance vise cette action de conversion.
   */
  eventName?: string;
  /**
   * Valeur monétaire. `undefined` (ou absent) déclenche le repli sur la
   * correspondance ; `null` signifie explicitement « sans valeur monétaire » et
   * ne déclenche rien.
   */
  value?: number | null;
  currency?: string;
  consentAdUserData: ConsentStatus;
  consentAdPersonalization: ConsentStatus;
}

export interface ResultatEnregistrement {
  /** `false` quand la conversion était déjà au journal : c'est un rejeu, pas une erreur. */
  cree: boolean;
  id: number | null;
}

/**
 * Refuse une conversion qui ne pourrait pas produire de message Data Manager.
 *
 * LÈVE au lieu de rendre un verdict, et c'est délibéré : contrairement au
 * doublon — normal, attendu, avalé en silence — c'est une faute d'appel. La
 * rendre discrète produirait des conversions manquantes sans trace.
 *
 * Ne contrôle QUE ce qui casserait la construction du message. Les règles
 * métier (consentement, fenêtre de 90 jours, mode d'essai) restent au drain :
 * elles dépendent des réglages du site et de l'instant, qui peuvent changer
 * entre l'écriture et l'envoi.
 */
export function verifierEnvoyable(conversion: ConversionAEnregistrer): void {
  if (typeof conversion.clickId !== "string" || conversion.clickId.trim() === "") {
    throw new TypeError(
      `Conversion « ${conversion.businessEventId} » sans identifiant de clic : ` +
        `Data Manager n'accepte aucun événement sans gclid/gbraid/wbraid.`,
    );
  }

  // Même contrôle que `formatEventTimestamp` (dataManager.ts), fait ici pour que
  // la ligne ne soit jamais écrite plutôt que découverte au drain.
  for (const [nom, valeur] of [
    ["occurredAt", conversion.occurredAt],
    ["clickAt", conversion.clickAt],
  ] as const) {
    const d = valeur instanceof Date ? valeur : new Date(valeur);
    if (Number.isNaN(d.getTime())) {
      throw new TypeError(
        `Conversion « ${conversion.businessEventId} » : « ${nom} » illisible (« ${String(valeur)} »).`,
      );
    }
  }
}

/**
 * Écrit une conversion à envoyer. **Idempotent** : un rejeu du même
 * `(site, événement métier, action de conversion)` ne crée rien et ne lève pas.
 *
 * Pourquoi ne pas lever sur le doublon, alors que la contrainte existe : les
 * appelants sont des webhooks et des files, qui redélivrent par conception. Une
 * exception à chaque redélivrance ferait du bruit d'exploitation permanent et
 * finirait par être avalée par un `catch` fourre-tout — c'est-à-dire par
 * masquer les vraies erreurs. Le doublon n'est pas une anomalie ici, c'est le
 * fonctionnement normal.
 *
 * ⚠️ Le triplet sert AUSSI de `transactionId` à Google (cf. `cleIdempotence`),
 * qui déduplique dessus. Un drain interrompu entre l'envoi et l'écriture du
 * `sent` réenverra donc la même conversion, sans jamais la compter deux fois.
 *
 * 🔴 `next_attempt_at` est posé EXPLICITEMENT, alors que la colonne porte un
 * `DEFAULT now()`. Ce n'est pas de la redondance : `now()` écrit dans un
 * `timestamp` sans fuseau rend l'heure MURALE de la session Postgres. Une base
 * dont le `TimeZone` n'est pas `UTC` daterait donc la ligne à `12:00` là où le
 * drain compare avec `10:00` — la conversion resterait invisible deux heures,
 * puis partirait, sans qu'aucune erreur ne le signale. Mesurable en changeant
 * le `TimeZone` de la session : c'est ce que fait `outbox.test.ts`.
 */
export async function enregistrerConversion(
  conversion: ConversionAEnregistrer,
  base: BaseOutbox = dbParDefaut as unknown as BaseOutbox,
  maintenant: Date = new Date(),
): Promise<ResultatEnregistrement> {
  // 🔴 Refus À LA SOURCE d'une ligne qui ne pourra jamais produire un message.
  //
  // Le drain sait désormais écarter une telle ligne seule (cf. `evenementDeLigne`),
  // mais l'écarter est un pis-aller : la conversion est perdue et personne ne
  // sait plus d'où elle venait. Ici, l'appelant est encore là, il a la commande
  // sous la main, et l'exception lui dit quoi corriger.
  //
  // Un `clickId` vide est le cas qui mord : il satisfait le `NOT NULL` de la
  // colonne, traverse tout le module sans encombre, et ne se révèle qu'au moment
  // de construire le message — trop tard, et jusqu'au 2026-08-29 en emportant
  // tout son lot. Le `CHECK` de la base est le filet ; il ne doit pas être le
  // premier à parler, sa violation remontant en 500 illisible.
  verifierEnvoyable(conversion);

  // Repli de valeur AVANT l'insertion : la correspondance n'est plus
  // consultable ensuite, le drain ne voyant qu'un identifiant d'action.
  let value = conversion.value;
  let currency = conversion.currency;
  if (value === undefined) {
    const defaut = await resoudreValeurParDefaut(base, conversion.siteId, conversion);
    value = defaut.value;
    currency = currency ?? defaut.currency ?? undefined;
    if (value === null) {
      // Pas un blocage : une prise de contact n'a légitimement pas de montant.
      // Mais c'est aussi le cas où un ROAS deviendrait faux en silence, donc ça
      // se trace, et `etatSante` compte ces lignes une fois envoyées.
      logger.info(
        { siteId: conversion.siteId, businessEventId: conversion.businessEventId },
        "Conversion enregistrée sans valeur monétaire (aucun défaut applicable)",
      );
    }
  }

  const resultat = await base.execute(sql`
    INSERT INTO ads_conversion_outbox (
      site_id, business_event_id, conversion_action_id,
      click_id_type, click_id, occurred_at, click_at,
      value, currency, consent_ad_user_data, consent_ad_personalization,
      next_attempt_at
    ) VALUES (
      ${conversion.siteId}, ${conversion.businessEventId}, ${conversion.conversionActionId},
      ${conversion.clickIdType}, ${conversion.clickId},
      ${versColonne(conversion.occurredAt)}, ${versColonne(conversion.clickAt)},
      ${value ?? null}, ${currency ?? "EUR"},
      ${conversion.consentAdUserData}, ${conversion.consentAdPersonalization},
      ${versColonne(maintenant)}::timestamp
    )
    ON CONFLICT ON CONSTRAINT ads_conversion_outbox_idempotence_unique DO NOTHING
    RETURNING id
  `);

  const lignes = lignesDe(resultat);
  if (lignes.length === 0) {
    logger.debug(
      { siteId: conversion.siteId, businessEventId: conversion.businessEventId },
      "Conversion déjà au journal, rejeu ignoré",
    );
    return { cree: false, id: null };
  }
  return { cree: true, id: Number(lignes[0].id) };
}

/**
 * Clé d'idempotence, et `transactionId` envoyé à Google. Le séparateur `:` est
 * arbitraire mais FIGÉ : le changer produirait des doublons chez Google pour
 * toutes les conversions déjà envoyées, sans aucune erreur pour le signaler.
 */
export function cleIdempotence(ligne: {
  siteId: number;
  businessEventId: string;
  conversionActionId: string;
}): string {
  return `${ligne.siteId}:${ligne.businessEventId}:${ligne.conversionActionId}`;
}

/* ──────────────────────────────── Drain ─────────────────────────────────── */

/**
 * Réclame un lot de lignes en attente, en posant un bail dessus.
 *
 * Une seule écriture, atomique, qui fait trois choses : elle sélectionne les
 * lignes dues, incrémente leur compteur de tentatives, et repousse leur
 * échéance de `BAIL_MS`. Elles disparaissent donc de la vue de tout autre drain
 * dès la fin de la requête, sans verrou tenu pendant l'appel réseau.
 *
 * `FOR UPDATE SKIP LOCKED` protège l'intervalle interne du `SELECT` contre deux
 * réclamations vraiment simultanées ; le bail protège tout le reste, y compris
 * la mort du processus. Les deux sont utiles et ne se remplacent pas.
 *
 * L'incrément des tentatives est fait ICI, à la réclamation, et non au retour :
 * un processus qui meurt en plein envoi consomme donc un essai. C'est voulu —
 * sinon une boucle de plantage réessaierait indéfiniment sans jamais atteindre
 * le budget d'essais, et la file ne se viderait jamais.
 */
export async function reclamerLot(
  base: BaseOutbox,
  maintenant: Date,
  limite: number = TAILLE_LOT,
): Promise<LigneOutbox[]> {
  const echeanceBail = versColonne(new Date(maintenant.getTime() + BAIL_MS));
  const maintenantSql = versColonne(maintenant);

  const resultat = await base.execute(sql`
    UPDATE ads_conversion_outbox AS o
       SET attempts = o.attempts + 1,
           next_attempt_at = ${echeanceBail}::timestamp,
           updated_at = ${maintenantSql}::timestamp
     WHERE o.id IN (
       SELECT c.id
         FROM ads_conversion_outbox AS c
        WHERE c.status = ${ETAT.enAttente}
          AND c.next_attempt_at <= ${maintenantSql}::timestamp
        ORDER BY c.next_attempt_at
        LIMIT ${limite}
          FOR UPDATE SKIP LOCKED
     )
    RETURNING o.id, o.site_id, o.business_event_id, o.conversion_action_id,
              o.click_id_type, o.click_id, o.value, o.currency,
              o.consent_ad_user_data, o.consent_ad_personalization, o.attempts,
              -- 🔴 Jamais o.occurred_at nu : le pilote parserait la colonne
              -- dans le fuseau du PROCESSUS et rendrait un instant décalé,
              -- irrécupérable ensuite. On rend une chaîne qui porte son Z.
              to_char(o.occurred_at, ${FORMAT_UTC}) AS occurred_at,
              to_char(o.click_at, ${FORMAT_UTC}) AS click_at
  `);

  return lignesDe(resultat).map(versLigne);
}

async function marquer(
  base: BaseOutbox,
  ids: number[],
  champs: {
    status: EtatOutbox;
    lastError?: string | null;
    sentAt?: string | null;
    googleRequestId?: string | null;
    nextAttemptAt?: string;
  },
  maintenant: Date,
): Promise<void> {
  if (ids.length === 0) return;
  await base.execute(sql`
    UPDATE ads_conversion_outbox
       SET status = ${champs.status},
           last_error = ${champs.lastError ?? null},
           sent_at = ${champs.sentAt ?? null}::timestamp,
           google_request_id = ${champs.googleRequestId ?? null},
           next_attempt_at = COALESCE(${champs.nextAttemptAt ?? null}::timestamp, next_attempt_at),
           updated_at = ${versColonne(maintenant)}::timestamp
     WHERE id IN ${sql.raw(`(${ids.map(n => Number(n)).join(",")})`)}
  `);
}

/** Ce que le drain sait faire du monde extérieur, injectable pour les tests. */
export interface DependancesDrain {
  base?: BaseOutbox;
  /** Réglages du site. Injecté pour éviter que le drain dépende de `settings.ts` (lot E). */
  chargerReglages?: (base: BaseOutbox, siteIds: number[]) => Promise<Map<number, ReglagesSite>>;
  credentials?: AdsCredentials;
  loginAccountId?: string;
  ingest?: typeof ingestConversions;
  optionsIngest?: IngestOptions;
  maintenant?: () => Date;
  limite?: number;
}

export interface BilanDrain {
  reclamees: number;
  envoyees: number;
  ecartees: number;
  reportees: number;
  echouees: number;
}

const BILAN_VIDE: BilanDrain = { reclamees: 0, envoyees: 0, ecartees: 0, reportees: 0, echouees: 0 };

/**
 * Réglages des sites du lot, lus par `lireReglages()` du lot E.
 *
 * On passe par leur fonction plutôt que par un SELECT local, alors que la
 * requête tiendrait en trois lignes : deux lectures concurrentes de la même
 * table finissent toujours par diverger — une validation ajoutée d'un côté, une
 * colonne projetée de l'autre — et l'écart ne se découvre qu'en production,
 * quand le drain et l'écran de réglages ne disent plus la même chose.
 *
 * Le coût est une lecture par site du lot plutôt qu'un `IN (…)`. Il est
 * négligeable : un lot porte au plus quelques sites distincts, et le drain
 * tourne toutes les deux minutes.
 */
async function chargerReglagesParDefaut(
  _base: BaseOutbox,
  siteIds: number[],
): Promise<Map<number, ReglagesSite>> {
  const carte = new Map<number, ReglagesSite>();
  const lues = await Promise.all(siteIds.map(id => lireReglages(id)));
  for (const r of lues) {
    if (r) {
      carte.set(r.siteId, {
        siteId: r.siteId,
        customerId: r.customerId,
        enabled: r.enabled,
        testMode: r.testMode,
      });
    }
  }
  return carte;
}

/**
 * Identifiants du compte administrateur, lus dans la configuration serveur.
 * Aucun jeton client n'est stocké : nos comptes clients vivent sous le MCC
 * Veridian, et le dépôt ne sait pas chiffrer un secret (cf. la conception).
 */
export function credentialsDepuisEnv(env: NodeJS.ProcessEnv = process.env): AdsCredentials | null {
  const clientId = env.GOOGLE_ADS_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_ADS_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/**
 * Vide la file : réclame un lot, applique les règles, envoie ce qui reste,
 * inscrit le résultat.
 *
 * Une seule passe par appel. Le drain repasse à la cadence du cron, ce qui
 * borne naturellement la charge et évite qu'un pic de conversions monopolise
 * une connexion du pool pendant des minutes.
 */
export async function drainerConversions(deps: DependancesDrain = {}): Promise<BilanDrain> {
  const base = deps.base ?? (dbParDefaut as unknown as BaseOutbox);
  const maintenant = (deps.maintenant ?? (() => new Date()))();
  const ingest = deps.ingest ?? ingestConversions;
  const chargerReglages = deps.chargerReglages ?? chargerReglagesParDefaut;

  const lignes = await reclamerLot(base, maintenant, deps.limite ?? TAILLE_LOT);
  if (lignes.length === 0) return { ...BILAN_VIDE };

  const bilan: BilanDrain = { ...BILAN_VIDE, reclamees: lignes.length };
  const reglages = await chargerReglages(base, [...new Set(lignes.map(l => l.siteId))]);

  // ── Les règles métier, avant tout appel réseau ──────────────────────────
  const aEnvoyer: LigneOutbox[] = [];
  for (const ligne of lignes) {
    const r = reglages.get(ligne.siteId);
    if (!r) {
      // Aucun réglage : le site n'a jamais été configuré pour Ads. Terminal,
      // comme un site désactivé — ce n'est pas une panne à réessayer.
      await marquer(
        base,
        [ligne.id],
        { status: ETAT.ecarte, lastError: `${MOTIF.siteDesactive}: aucun réglage Ads pour ce site` },
        maintenant,
      );
      bilan.ecartees += 1;
      continue;
    }

    const verdict = evaluerEnvoi(ligne, r, maintenant);
    if (!verdict.envoyer) {
      await marquer(
        base,
        [ligne.id],
        { status: ETAT.ecarte, lastError: `${verdict.motif}: ${verdict.detail}` },
        maintenant,
      );
      bilan.ecartees += 1;
      logger.info(
        { id: ligne.id, siteId: ligne.siteId, motif: verdict.motif },
        "Conversion écartée avant envoi",
      );
      continue;
    }
    aEnvoyer.push(ligne);
  }

  if (aEnvoyer.length === 0) return bilan;

  const credentials = deps.credentials ?? credentialsDepuisEnv();
  if (!credentials) {
    // Configuration serveur absente : transitoire par nature (un secret se
    // pose), donc report plutôt qu'échec définitif. On ne consomme pas non plus
    // le budget d'essais pour rien : le report suffit à ne pas boucler.
    for (const ligne of aEnvoyer) {
      await marquer(
        base,
        [ligne.id],
        {
          status: ETAT.enAttente,
          lastError: "identifiants Google Ads absents de la configuration serveur",
          nextAttemptAt: versColonne(new Date(maintenant.getTime() + reportProchaineTentative(ligne.attempts))),
        },
        maintenant,
      );
    }
    bilan.reportees += aEnvoyer.length;
    logger.error("Drain Ads sans identifiants : GOOGLE_ADS_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN");
    return bilan;
  }

  // ── Regroupement par destination ────────────────────────────────────────
  // Un envoi Data Manager porte UNE destination. Le lot est donc découpé par
  // (compte Ads, action de conversion), et un groupe qui échoue n'entraîne pas
  // les autres.
  const groupes = new Map<string, LigneOutbox[]>();
  for (const ligne of aEnvoyer) {
    const cle = `${reglages.get(ligne.siteId)!.customerId}|${ligne.conversionActionId}`;
    const g = groupes.get(cle);
    if (g) g.push(ligne);
    else groupes.set(cle, [ligne]);
  }

  for (const [cle, groupe] of groupes) {
    const [operatingAccountId, conversionActionIdGroupe] = cle.split("|");
    const destination: AdsDestination = {
      operatingAccountId,
      loginAccountId: deps.loginAccountId ?? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
      conversionActionId: conversionActionIdGroupe,
    };

    // ── Construction LIGNE PAR LIGNE ───────────────────────────────────────
    //
    // 🔴 Le lot ne doit pas mourir avec l'une de ses lignes. `buildIngestPayload`
    // construit tout le message d'un coup, donc une seule ligne indigeste — un
    // `click_id` vide, un horodatage illisible — y lève AVANT le moindre appel
    // réseau, en `retryable: false`. Le lot entier partait alors en échec
    // définitif : jusqu'à 199 conversions parfaitement valides perdues, sans
    // rattrapage possible, pour la faute d'une voisine.
    //
    // On force donc la même construction ici, ligne par ligne, avec les
    // fonctions QUI LÈVERONT plus tard — et non une copie de leurs règles, qui
    // divergerait sans que rien ne le signale.
    const envoyables: { ligne: LigneOutbox; evenement: ConversionEvent }[] = [];
    const impossibles: { ligne: LigneOutbox; raison: string }[] = [];

    for (const ligne of groupe) {
      const evenement = {
        transactionId: cleIdempotence(ligne),
        [ligne.clickIdType]: ligne.clickId,
        // ⚠️ `toISOString()` sur une Date reconstruite par `depuisColonne` : le
        // fuseau du processus n'intervient à aucun moment de la chaîne.
        occurredAt: ligne.occurredAt.toISOString(),
        value: ligne.value ?? 0,
        currency: ligne.currency,
        consent: {
          adUserData: ligne.consentAdUserData as ConsentStatus,
          adPersonalization: ligne.consentAdPersonalization as ConsentStatus,
        },
      } as ConversionEvent;

      try {
        pickAdIdentifiers(evenement);
        formatEventTimestamp(evenement.occurredAt);
        envoyables.push({ ligne, evenement });
      } catch (err) {
        impossibles.push({ ligne, raison: (err as Error).message });
      }
    }

    for (const { ligne, raison } of impossibles) {
      // `failed` et non `skipped` : rien n'a été décidé, la ligne est cassée.
      // Et sans réessai — le message ne deviendra pas constructible tout seul.
      await marquer(
        base,
        [ligne.id],
        { status: ETAT.echoue, lastError: `${MOTIF.messageImpossible}: ${raison}`.slice(0, 900) },
        maintenant,
      );
    }
    if (impossibles.length > 0) {
      bilan.echouees += impossibles.length;
      logger.warn(
        { count: impossibles.length, ids: impossibles.map(i => i.ligne.id) },
        "Conversions écartées du lot : message impossible à construire",
      );
    }

    if (envoyables.length === 0) continue;

    const lignesEnvoyees = envoyables.map(e => e.ligne);
    const evenements = envoyables.map(e => e.evenement);

    try {
      const res = await ingest(credentials, destination, evenements, deps.optionsIngest ?? {});
      await marquer(
        base,
        lignesEnvoyees.map(l => l.id),
        {
          status: ETAT.envoye,
          sentAt: versColonne(maintenant),
          googleRequestId: res.requestId,
          lastError: null,
        },
        maintenant,
      );
      bilan.envoyees += lignesEnvoyees.length;
      logger.info(
        { requestId: res.requestId, count: lignesEnvoyees.length, conversionActionId: conversionActionIdGroupe },
        "Conversions envoyées à Data Manager",
      );
    } catch (err) {
      const ads = err instanceof AdsIngestError ? err : null;
      // Une erreur qui n'est pas une `AdsIngestError` (bogue, panne inattendue)
      // est traitée comme transitoire : abandonner définitivement sur un défaut
      // qu'on n'a pas classé ferait perdre des conversions réparables.
      const reessayable = ads ? ads.retryable : true;
      const message = `${ads?.status ?? "?"} ${(err as Error).message}`.slice(0, 900);

      // ⚠️ LIMITE ASSUMÉE, et il faut la connaître : ce `catch` traite le lot en
      // bloc. Un HTTP 400 provoqué par UNE ligne que nous n'avons pas su juger
      // fautive fait donc encore tomber tout le groupe. La différence avec
      // l'ancien comportement est qu'il ne reste ici que des défauts venant de
      // Google, invisibles depuis notre code : ceux que nous savons détecter
      // sont écartés un par un juste au-dessus. Découper le lot par bissection
      // couvrirait le reste, au prix d'autant d'appels supplémentaires et d'une
      // complexité qu'aucune mesure ne justifie aujourd'hui — le jour où le
      // compteur `failed` montera par paquets de 200, ce sera la piste.
      const definitifs: number[] = [];
      const reportes: LigneOutbox[] = [];
      for (const ligne of lignesEnvoyees) {
        // `attempts` a déjà été incrémenté par la réclamation.
        if (!reessayable || ligne.attempts >= MAX_TENTATIVES) definitifs.push(ligne.id);
        else reportes.push(ligne);
      }

      await marquer(
        base,
        definitifs,
        {
          status: ETAT.echoue,
          lastError: reessayable ? `${MOTIF.budgetEpuise}: ${message}` : message,
        },
        maintenant,
      );
      bilan.echouees += definitifs.length;

      for (const ligne of reportes) {
        await marquer(
          base,
          [ligne.id],
          {
            status: ETAT.enAttente,
            lastError: message,
            nextAttemptAt: versColonne(
              new Date(maintenant.getTime() + reportProchaineTentative(ligne.attempts)),
            ),
          },
          maintenant,
        );
      }
      bilan.reportees += reportes.length;

      logger.warn(
        { status: ads?.status, retryable: reessayable, definitifs: definitifs.length, reportes: reportes.length },
        "Envoi de conversions en échec",
      );
    }
  }

  return bilan;
}

/* ─────────────────────────── Service planifié ───────────────────────────── */

/**
 * Le drain planifié, sur le patron de `usageService` : un singleton qui porte sa
 * tâche cron et expose start/stop.
 */
class AdsOutboxService {
  private drainTask: cron.ScheduledTask | null = null;
  private logger = createServiceLogger("ads-outbox-cron");
  /** Empêche deux passages de se chevaucher DANS le même processus (drain lent, cadence courte). */
  private enCours = false;

  private initializeDrainCron() {
    // 🔴 Le garde qui compte. `CLUSTER_WORKERS` vaut 4 en production : sans lui,
    // quatre processus drainent la même file en même temps. Le bail de
    // `reclamerLot` et la déduplication de Google éviteraient le doublon de
    // conversion, mais on paierait quatre fois les requêtes et les jetons OAuth,
    // et les journaux deviendraient illisibles.
    //
    // `index.ts` pose déjà ce garde autour de ses crons ; on le répète ici parce
    // qu'un futur appelant qui l'oublierait ne provoquerait aucune erreur
    // visible — juste une charge multipliée par quatre que personne ne
    // remarquerait.
    if (cluster.isWorker) {
      this.logger.debug("Drain Ads non planifié sur un worker de cluster");
      return;
    }

    this.drainTask = cron.schedule(
      CADENCE_DRAIN,
      async () => {
        if (this.enCours) {
          this.logger.warn("Passage de drain sauté : le précédent n'est pas terminé");
          return;
        }
        this.enCours = true;
        try {
          const bilan = await drainerConversions();
          if (bilan.reclamees > 0) this.logger.info(bilan, "Passage de drain terminé");
        } catch (error) {
          this.logger.error(error as Error, "Erreur pendant le drain des conversions Ads");
        } finally {
          this.enCours = false;
        }
      },
      { timezone: "UTC" },
    );

    this.logger.info(`Drain des conversions Ads planifié (${CADENCE_DRAIN})`);
  }

  public startAdsDrainCron() {
    this.initializeDrainCron();
  }

  public stopAdsDrainCron() {
    if (this.drainTask) {
      this.drainTask.stop();
      this.drainTask = null;
      this.logger.info("Drain des conversions Ads arrêté");
    }
  }

  /** Un passage immédiat, pour les diagnostics et les tests de bout en bout. */
  public async drainMaintenant(deps: DependancesDrain = {}): Promise<BilanDrain> {
    return drainerConversions(deps);
  }
}

export const adsOutboxService = new AdsOutboxService();
