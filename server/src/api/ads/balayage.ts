/**
 * Le déclencheur : « un événement métier a été mesuré → on retrouve son
 * identifiant de clic → on l'inscrit au journal ».
 *
 * C'est la couture qui manquait au module. Les lots A à F savaient tout faire —
 * parler à Google, retrouver un clic, tenir un journal idempotent, le drainer —
 * mais **rien n'appelait `enregistrerConversion`**. Le drain tournait toutes les
 * deux minutes sur une table structurellement vide, et l'écran de santé affichait
 * « configuré, activé, 0 en attente, 0 envoyé », indistinguable d'un site
 * simplement calme. Le motif « répond OK sans rien faire », appliqué au module
 * entier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 Un BALAYAGE, et pas un branchement dans l'ingestion
 *
 * La conception pose comme invariant que rien ne s'intercale dans le chemin
 * d'ingestion : c'est ce qui protège la mesure des sites clients si l'envoi vers
 * Google tombe. Ce fichier LIT ce qui est déjà écrit, périodiquement.
 *
 * Ce qu'on y gagne : le balayage est isolé (une panne ici ne peut pas ralentir
 * une mesure ni en perdre une), il RATTRAPE son retard après un incident — un
 * passage manqué est repris au suivant, sans rien à réparer — et il se rejoue
 * sans conséquence.
 *
 * Ce qu'on y perd : quelques minutes de latence. Sans importance pour des
 * conversions hors ligne, qui sont de toute façon consolidées par Google sur
 * plusieurs heures.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 Pas de curseur : une FENÊTRE GLISSANTE, et l'idempotence pour tout filet
 *
 * Un curseur (« jusqu'où a-t-on balayé ») est la solution évidente, et c'est la
 * mauvaise ici. Il faudrait le persister, donc une table de plus ; il se corrompt
 * (un curseur avancé trop tôt perd définitivement ce qui n'était pas encore
 * écrit) ; et **une conversion perdue ne se rattrape pas**, alors qu'une
 * conversion relue ne coûte rien : la clé d'unicité du journal est
 * `(site, événement métier, action)` et `enregistrerConversion` ne fait RIEN sur
 * un rejeu.
 *
 * On relit donc toute une fenêtre à chaque passage, avec un large recouvrement.
 * Le coût est borné par deux mesures :
 *
 *  - une seule requête ClickHouse par site et par passage, sur la plage triée de
 *    la table (`ORDER BY (site_id, timestamp)`) ;
 *  - les identifiants métier DÉJÀ au journal sont lus en UNE requête Postgres et
 *    écartés avant toute recherche d'identifiant de clic — la partie chère.
 *
 * ⚠️ Ce que la fenêtre ne rattrape pas : un événement dont l'HORODATAGE est plus
 * vieux que la fenêtre au moment où il est écrit (un client hors ligne pendant
 * trois jours). `events` ne porte pas de date d'ingestion, donc rien ne permet de
 * le voir. Élargir `FENETRE_RATTRAPAGE_HEURES` est le seul remède, et il est bon
 * marché.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 L'identifiant métier : ce que `events` ne porte PAS
 *
 * La table n'a **aucun identifiant de ligne**. Il faut donc en fabriquer un qui
 * soit déterministe (rejouer un passage ne doit rien créer) sans confondre deux
 * achats distincts du même client. Deux cas, dans cet ordre :
 *
 *  1. **`props` porte un identifiant de commande** (`order_id`, `transaction_id`…).
 *     C'est la seule clé vraiment métier : elle survit à une réécriture de
 *     l'événement, à un changement d'horodatage, à un doublon d'ingestion. On la
 *     privilégie toujours ;
 *  2. **sinon**, une empreinte de ce qui identifie l'événement : nom, horodatage
 *     à la seconde, session, et le contenu de `props` normalisé.
 *
 * ⚠️ Mesuré le 2026-08-29 : le site ASD n'envoie AUCUN identifiant de commande
 * (`trackOrderConfirmed` porte `total_eur`, `items`, `shipping_mode`,
 * `is_subscription`, `logged_in`). Le cas 2 est donc celui qui s'appliquera en
 * production, et sa limite doit être dite : deux commandes de la même session, à
 * la même seconde, avec exactement les mêmes propriétés, se confondent en une.
 * C'est indiscernable d'un double envoi du même événement — et dans ce cas la
 * fusion est le comportement voulu.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 Le consentement : rien ne part, et rien n'est même STOCKÉ, sans lui
 *
 * `events` ne porte pas le consentement publicitaire. Il doit donc voyager dans
 * `props` (cf. `CLES_CONSENT_*`). En son absence, l'événement est compté et
 * ignoré : on ne va même pas chercher son identifiant de clic.
 *
 * Ce n'est pas de la prudence décorative. Inscrire la ligne au journal pour la
 * laisser écarter par le drain donnerait un compteur plus visible, mais cela
 * reviendrait à STOCKER un identifiant publicitaire rattaché à quelqu'un qui a
 * refusé l'usage publicitaire de ses données. Le compteur est donc dans le bilan
 * du passage et dans le journal applicatif, pas dans la base.
 *
 * ⚠️ Conséquence à connaître avant de conclure « le module ne marche pas » : un
 * site dont le traceur n'émet pas ces propriétés verra `ignoresSansConsentement`
 * monter et `inscrits` rester à zéro. C'est un site à câbler, pas une panne. Le
 * bilan le dit à chaque passage.
 */
import cluster from "node:cluster";
import { createHash } from "node:crypto";
import * as cron from "node-cron";
import { sql } from "drizzle-orm";
import { db as dbParDefaut } from "../../db/postgres/postgres.js";
import { createServiceLogger } from "../../lib/logger/logger.js";
import { effectiveUserId } from "../analytics/utils/effectiveUserId.js";
import { QuerySpec, runAnalyticsQuery } from "../analytics/utils/analyticsQuery.js";
import { normalizeDatetimeForClickhouse } from "../analytics/utils/timeWindow.js";
import { retrouverIdentifiantClic } from "./attribution.js";
import { enregistrerConversion, versColonne, type BaseOutbox } from "./outbox.js";
import type { ConsentStatus } from "./dataManager.js";

const logger = createServiceLogger("ads-balayage");

/* ────────────────────────────── Réglages ────────────────────────────────── */

/**
 * Cadence du balayage.
 *
 * Cinq minutes, et non deux comme le drain : une passe de balayage interroge
 * ClickHouse par site, là où une passe de drain lit un index Postgres. Une
 * conversion hors ligne n'a de toute façon aucune urgence à la minute — Google
 * consolide sur plusieurs heures.
 */
export const CADENCE_BALAYAGE = "*/5 * * * *";

/**
 * Profondeur relue à chaque passage, en heures.
 *
 * Généreuse à dessein : c'est ce qui remplace un curseur. Deux passages
 * consécutifs se recouvrent donc de presque 48 h, et un incident d'une journée
 * entière se rattrape tout seul au premier passage qui suit. Le surcoût est une
 * requête ClickHouse sur une plage plus large, sans aucune écriture
 * supplémentaire (les identifiants déjà connus sont écartés avant l'attribution).
 */
export const FENETRE_RATTRAPAGE_HEURES = Number(process.env.ADS_SCAN_LOOKBACK_HOURS ?? 48);

/**
 * Événements lus par site et par passage.
 *
 * Le tri est ASCENDANT : si la borne mord, ce sont les événements les plus
 * ANCIENS qui passent — ceux qui sont sur le point de sortir de la fenêtre de
 * rattrapage et qu'on ne reverrait jamais. Les plus récents, eux, seront relus au
 * passage suivant.
 *
 * 🔴 Une troncature est signalée dans le bilan et journalisée en `warn`. Sans
 * cela, un site à fort volume perdrait des conversions à chaque passage sans
 * qu'aucun compteur ne bouge — exactement le défaut que ce module existe pour ne
 * pas fabriquer.
 */
export const LIMITE_EVENEMENTS = 5000;

/**
 * Clés de `props` acceptées comme identifiant métier, PAR ORDRE DE PRÉFÉRENCE.
 *
 * Liste FERMÉE et volontairement courte. Accepter n'importe quelle clé finissant
 * par `_id` ferait basculer la clé d'unicité d'un site le jour où quelqu'un
 * ajoute une propriété : toutes les conversions déjà envoyées seraient réécrites
 * sous une nouvelle clé, donc renvoyées, et Google les compterait deux fois
 * puisque le `transactionId` aurait changé lui aussi.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 L'ORDRE EST LE POINT DÉLICAT, et il est contre-intuitif
 *
 * ASD envoie DEUX identifiants sur `order_confirmed` : celui de l'ERP
 * (`order_id`, présent SEULEMENT si la commande a été matérialisée) et celui de
 * la session de paiement Stripe (`checkout_session_id`, présent MÊME quand la
 * commande s'est perdue, et stable au rechargement de la page de succès).
 *
 * La session de paiement passe DEVANT, et le raisonnement n'est pas « laquelle
 * est la plus jolie » mais « laquelle est toujours là ».
 *
 * Préférer l'identifiant ERP fabriquerait exactement la panne qu'on vient de
 * retirer de l'empreinte composite : l'événement émis avant que la commande soit
 * matérialisée porte la seule session de paiement, donc une première clé ; le
 * même achat vu plus tard avec son `order_id` en porterait une SECONDE. Deux
 * lignes au journal, deux `transactionId`, **une commande comptée deux fois par
 * Google**, sans la moindre erreur. Un identifiant conditionnellement présent ne
 * peut jamais être une clé d'idempotence — c'est le même défaut que l'identité
 * réécrite après coup, sous un autre visage.
 *
 * Ce que ça coûte : le lien vers la facturation est moins direct dans la base.
 * C'est sans conséquence ici — le journal sert à ne pas envoyer deux fois, pas à
 * rapprocher une comptabilité, et `order_id` reste dans `props` pour qui veut
 * faire le rapprochement.
 *
 * Un paiement relancé après échec crée une NOUVELLE session Stripe, donc une
 * nouvelle clé : c'est bien une nouvelle conversion, et c'est le comportement
 * voulu.
 */
export const CLES_IDENTIFIANT_METIER = [
  // Toujours présent dès qu'un paiement a été ouvert : la seule vraie clé.
  "checkout_session_id",
  "checkoutSessionId",
  // Repli quand il n'y a pas de session de paiement (autre tunnel, autre client).
  "order_id",
  "orderId",
  "transaction_id",
  "transactionId",
  "business_event_id",
  "businessEventId",
] as const;

/** Clés de `props` portant le consentement à l'usage publicitaire des données. */
export const CLES_CONSENT_AD_USER_DATA = ["ads_consent_ad_user_data", "consent_ad_user_data", "ad_user_data"] as const;
/** Clés de `props` portant le consentement à la personnalisation publicitaire. */
export const CLES_CONSENT_AD_PERSONALIZATION = [
  "ads_consent_ad_personalization",
  "consent_ad_personalization",
  "ad_personalization",
] as const;

/**
 * Clés de `props` acceptées comme valeur monétaire, et la devise qu'elles
 * impliquent (`null` = à lire dans `props.currency`, sinon le défaut de la
 * correspondance).
 *
 * 🔴 Liste FERMÉE, pour la raison que pose `outbox.ts` : un montant faux et
 * plausible est pire que zéro, parce que zéro se voit. On ne devine donc jamais
 * « le champ qui ressemble à un prix ». Les clés suffixées `_eur` portent leur
 * devise dans leur nom — c'est ce que fait le site ASD (`total_eur`).
 */
export const CLES_VALEUR: ReadonlyArray<readonly [string, string | null]> = [
  ["value", null],
  ["conversion_value", null],
  ["revenue", null],
  ["amount", null],
  ["value_eur", "EUR"],
  ["total_eur", "EUR"],
  ["revenue_eur", "EUR"],
  ["amount_eur", "EUR"],
];

/* ───────────────────────── Lecture des propriétés ───────────────────────── */

/** `props` tel que ClickHouse le rend (`toString(props)`), décodé sans jamais lever. */
export function lireProps(brut: unknown): Record<string, unknown> {
  if (brut && typeof brut === "object" && !Array.isArray(brut)) return brut as Record<string, unknown>;
  if (typeof brut !== "string" || brut.trim() === "") return {};
  try {
    const parse: unknown = JSON.parse(brut);
    return parse && typeof parse === "object" && !Array.isArray(parse) ? (parse as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Première clé présente et non vide, dans l'ordre donné. */
function premiereValeur(props: Record<string, unknown>, cles: readonly string[]): unknown {
  for (const cle of cles) {
    const v = props[cle];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/**
 * Sérialisation STABLE d'un objet : clés triées, à toute profondeur.
 *
 * Le tri n'est pas cosmétique. L'empreinte de l'événement en dépend, donc un
 * ordre de clés qui changerait entre deux lectures produirait un identifiant
 * métier différent pour le MÊME événement — donc une seconde conversion envoyée
 * à Google, sous un `transactionId` neuf, donc comptée deux fois. Sans erreur.
 */
export function serialiserStable(valeur: unknown): string {
  if (valeur === null || typeof valeur !== "object") return JSON.stringify(valeur) ?? "null";
  if (Array.isArray(valeur)) return `[${valeur.map(serialiserStable).join(",")}]`;
  const entrees = Object.keys(valeur as Record<string, unknown>)
    .sort()
    .map(cle => `${JSON.stringify(cle)}:${serialiserStable((valeur as Record<string, unknown>)[cle])}`);
  return `{${entrees.join(",")}}`;
}

/** Une ligne du comptage des événements qu'aucune correspondance ne couvre. */
export interface LigneNonMappee {
  eventName: string;
  n: number | string;
}

/** Un événement métier lu dans ClickHouse. */
export interface EvenementMetier {
  eventName: string;
  /** RFC 3339 UTC, rendu par la requête (`%FT%TZ`, jamais `%Y-%m-%dT%H:%M:%SZ`). */
  horodatage: string;
  sessionId: string;
  /** `identified_user_id` s'il existe, sinon l'empreinte d'appareil. */
  utilisateur: string;
  /** `toString(props)`. */
  props: string;
}

/**
 * Identifiant métier STABLE de l'événement. Fonction PURE.
 *
 * Deux exigences contradictoires à concilier, et c'est tout l'enjeu du fichier :
 * rejouer le balayage sur la même période ne doit RIEN créer de nouveau, et deux
 * achats distincts du même client ne doivent pas se confondre.
 *
 * Le préfixe (`cmd:` / `evt:`) est là pour que les deux espaces de nommage ne se
 * croisent jamais : un site qui se met à envoyer `order_id` en cours de route
 * verra ses nouvelles conversions changer de clé, et il vaut mieux que ce soit
 * lisible dans la base plutôt que déguisé en collision.
 */
export function identifiantEvenementMetier(evenement: EvenementMetier): string {
  const props = lireProps(evenement.props);

  const metier = premiereValeur(props, CLES_IDENTIFIANT_METIER);
  if (metier !== undefined) return `cmd:${evenement.eventName}:${String(metier)}`;

  // Aucun identifiant de commande : on retombe sur ce qui identifie la ligne.
  //
  // 🔴 L'IDENTITÉ DE L'UTILISATEUR N'ENTRE PAS DANS L'EMPREINTE, et c'est le
  // point le plus contre-intuitif de ce fichier. `identifyService` réécrit
  // RÉTROACTIVEMENT `identified_user_id` sur les événements anonymes des trente
  // derniers jours (`ALTER TABLE events UPDATE …`, identifyService.ts:81). Une
  // ligne balayée aujourd'hui comme anonyme peut donc porter demain une identité,
  // et dans la fenêtre de rattrapage c'est le scénario ORDINAIRE : on achète, puis
  // on crée son compte une heure plus tard.
  //
  // Faire entrer l'identité dans la clé signifierait alors : nouvelle clé pour le
  // même achat, donc nouvelle ligne au journal, donc nouveau `transactionId`, donc
  // une seconde conversion COMPTÉE par Google. Sans la moindre erreur, ni chez
  // nous ni chez eux. C'est précisément la panne que ce module existe pour ne pas
  // fabriquer.
  //
  // `session_id` n'est jamais muté, lui, et discrimine déjà deux personnes. Si un
  // site n'en émettait pas, la clé se dégraderait en (événement, instant, props) :
  // deux conversions distinctes fusionneraient, donc on en compterait UNE de
  // moins. C'est le bon sens de l'erreur, une conversion manquante se voit et se
  // corrige, une conversion en double fausse les enchères en silence.
  //
  // Le séparateur est un octet NUL : aucun contenu de props ne peut le porter,
  // donc deux découpages différents ne peuvent pas produire la même chaîne.
  const empreinte = createHash("sha256")
    .update(
      [evenement.eventName, evenement.horodatage, evenement.sessionId ?? "", serialiserStable(props)].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 32);

  return `evt:${evenement.eventName}:${empreinte}`;
}

/**
 * Consentement publicitaire porté par l'événement. Fonction PURE.
 *
 * Tout ce qui n'est pas un accord explicite vaut `CONSENT_UNSPECIFIED`, et
 * `CONSENT_UNSPECIFIED` n'est pas un accord : dans l'EEE, l'absence de réponse
 * vaut refus. Mesuré (conception, décision n°5) : Google répond 200 à un
 * événement marqué `CONSENT_DENIED`, donc le blocage est ici ou nulle part.
 */
export function lireConsentement(props: Record<string, unknown>): {
  adUserData: ConsentStatus;
  adPersonalization: ConsentStatus;
} {
  const etat = (brut: unknown): ConsentStatus => {
    if (brut === true) return "CONSENT_GRANTED";
    if (brut === false) return "CONSENT_DENIED";
    const s = String(brut ?? "")
      .trim()
      .toUpperCase();
    if (s === "GRANTED" || s === "CONSENT_GRANTED" || s === "TRUE" || s === "1") return "CONSENT_GRANTED";
    if (s === "DENIED" || s === "CONSENT_DENIED" || s === "FALSE" || s === "0") return "CONSENT_DENIED";
    return "CONSENT_UNSPECIFIED";
  };

  const adUserData = etat(premiereValeur(props, CLES_CONSENT_AD_USER_DATA));
  const brutPerso = premiereValeur(props, CLES_CONSENT_AD_PERSONALIZATION);
  // La personnalisation, absente, suit l'usage des données : c'est une
  // déclaration envoyée à Google, pas un garde-fou (le garde-fou est
  // `adUserData`, et il est appliqué par `evaluerEnvoi`).
  const adPersonalization = brutPerso === undefined ? adUserData : etat(brutPerso);

  return { adUserData, adPersonalization };
}

/**
 * Valeur monétaire portée par l'événement. Fonction PURE.
 *
 * Rend `undefined` — et non `null` — quand l'événement ne porte rien : la
 * distinction est celle de `enregistrerConversion`, où `undefined` veut dire
 * « cherche le défaut de la correspondance » et `null` « cette conversion n'a
 * légitimement pas de valeur ». Ce fichier ne prononce jamais le second : il ne
 * sait pas si l'absence est voulue, la correspondance le sait.
 */
export function lireValeur(props: Record<string, unknown>): { value?: number; currency?: string } {
  for (const [cle, deviseImplicite] of CLES_VALEUR) {
    const brut = props[cle];
    if (brut === undefined || brut === null || brut === "") continue;
    const nombre = typeof brut === "number" ? brut : Number(String(brut).replace(",", "."));
    if (!Number.isFinite(nombre) || nombre < 0) continue;

    const devise = deviseImplicite ?? (typeof props.currency === "string" ? props.currency.toUpperCase() : undefined);
    return devise ? { value: nombre, currency: devise } : { value: nombre };
  }
  return {};
}

/* ─────────────────────────── Requête ClickHouse ─────────────────────────── */

export interface ParametresRequeteEvenements {
  siteId: number;
  /** Noms d'événements des correspondances du site. */
  noms: string[];
  debut: Date;
  fin: Date;
  limite?: number;
}

/**
 * Construit la requête. Fonction PURE : un test vérifie le SQL et ses paramètres
 * sans ClickHouse, motif du dépôt (`construireRequeteClic`, `buildUserInfoQueries`).
 *
 * ⚠️ Aucune valeur n'est concaténée : tout passe par des paramètres liés.
 *
 * ⚠️ `formatDateTime(…, '%FT%TZ', 'UTC')` — jamais `'%Y-%m-%dT%H:%M:%SZ'`, où
 * `%M` est le MOIS EN TOUTES LETTRES et produit `2026-08-29T10:August:22Z` sans
 * la moindre erreur. Et l'ancrage explicite sur `'UTC'` aux trois endroits, parce
 * que la colonne est un `DateTime` SANS fuseau que ClickHouse rend dans le fuseau
 * du SERVEUR.
 */
export function construireRequeteEvenements({
  siteId,
  noms,
  debut,
  fin,
  limite = LIMITE_EVENEMENTS,
}: ParametresRequeteEvenements): QuerySpec {
  const query = `
    SELECT
        event_name AS eventName,
        formatDateTime(timestamp, '%FT%TZ', 'UTC') AS horodatage,
        session_id AS sessionId,
        ${effectiveUserId()} AS utilisateur,
        toString(props) AS props
    FROM events
    WHERE
        site_id = {siteId:UInt16}
        AND timestamp >= toDateTime({debut:String}, 'UTC')
        AND timestamp <= toDateTime({fin:String}, 'UTC')
        AND event_name IN ({noms:Array(String)})
    ORDER BY timestamp ASC
    LIMIT {limite:UInt32}
  `;

  return {
    query,
    params: {
      siteId,
      noms,
      debut: normalizeDatetimeForClickhouse(debut.toISOString()),
      fin: normalizeDatetimeForClickhouse(fin.toISOString()),
      limite,
    },
  };
}

/**
 * Compte les événements personnalisés que AUCUNE correspondance ne couvre, et
 * remonte les plus fréquents.
 *
 * 🔴 C'est le diagnostic de la panne la plus banale du module, et celle qu'aucun
 * autre compteur ne peut voir : une correspondance saisie `order_paid` alors que
 * le site émet `order_confirmed`. Le balayage ne demande que les noms mappés,
 * donc il ne lit RIEN, donc tous ses compteurs valent zéro — et l'écran est
 * indistinguable d'un site sans trafic. Le seul moyen de trancher est d'aller
 * demander ce que le site émet RÉELLEMENT.
 *
 * Une agrégation sur la même plage indexée que la requête principale, bornée à
 * cinq noms. Elle tourne même quand le site n'a aucune correspondance : c'est
 * précisément le cas le plus cassé.
 *
 * ⚠️ `event_name != ''` écarte les pages vues, qui n'ont pas de nom : sans ce
 * filtre le compteur remonterait tout le trafic du site et ne voudrait plus rien
 * dire.
 */
export function construireRequeteNonMappes({
  siteId,
  noms,
  debut,
  fin,
}: Omit<ParametresRequeteEvenements, "limite">): QuerySpec {
  const query = `
    SELECT event_name AS eventName, count() AS n
    FROM events
    WHERE
        site_id = {siteId:UInt16}
        AND timestamp >= toDateTime({debut:String}, 'UTC')
        AND timestamp <= toDateTime({fin:String}, 'UTC')
        AND event_name != ''
        AND event_name NOT IN ({noms:Array(String)})
    GROUP BY event_name
    ORDER BY n DESC
    LIMIT 5
  `;

  return {
    query,
    params: {
      siteId,
      noms,
      debut: normalizeDatetimeForClickhouse(debut.toISOString()),
      fin: normalizeDatetimeForClickhouse(fin.toISOString()),
    },
  };
}

/* ──────────────────────────────── Balayage ──────────────────────────────── */

export interface BilanBalayage {
  /** Sites activés effectivement balayés. */
  sites: number;
  /** Événements mappés lus dans ClickHouse. */
  evenements: number;
  /** Déjà au journal : le rejeu attendu, et la preuve que l'idempotence tient. */
  dejaConnus: number;
  /** Deux lignes ClickHouse de même identifiant métier dans le même lot. */
  doublons: number;
  /** Aucun consentement publicitaire établi : ni attribution, ni écriture. */
  ignoresSansConsentement: number;
  /** Aucun identifiant de clic dans la fenêtre : le cas majoritaire (trafic non payant). */
  ignoresSansClic: number;
  /** Lignes réellement ajoutées au journal. */
  inscrits: number;
  /** Sites dont le balayage a échoué (ClickHouse, base). Le passage continue. */
  erreurs: number;
  /** Sites où `LIMITE_EVENEMENTS` a mordu : il reste des événements non vus. */
  tronques: number;
  /**
   * Événements personnalisés vus sur la fenêtre qu'aucune correspondance ne
   * couvre. Le seul chiffre qui distingue « le site n'émet rien » de « le site
   * émet, mais sous d'autres noms que ceux qu'on a saisis ».
   */
  nonMappes: number;
  /** Les cinq noms non couverts les plus fréquents, pour rendre le diagnostic immédiat. */
  nomsNonMappes: string[];
}

const BILAN_VIDE: BilanBalayage = {
  sites: 0,
  evenements: 0,
  dejaConnus: 0,
  doublons: 0,
  ignoresSansConsentement: 0,
  ignoresSansClic: 0,
  inscrits: 0,
  erreurs: 0,
  tronques: 0,
  nonMappes: 0,
  nomsNonMappes: [],
};

/** Ce que le balayage sait faire du monde extérieur, injectable pour les tests. */
export interface DependancesBalayage {
  base?: BaseOutbox;
  /** Lecture ClickHouse. Injectée pour que les tests n'aient pas de ClickHouse. */
  lireEvenements?: (spec: QuerySpec) => Promise<EvenementMetier[]>;
  /** Comptage des événements non couverts par une correspondance. */
  compterNonMappes?: (spec: QuerySpec) => Promise<LigneNonMappee[]>;
  /** Le SEUL point qui relie le balayage au lot C. Par défaut : la vraie fonction. */
  attribuer?: typeof retrouverIdentifiantClic;
  /** Le SEUL point qui relie le balayage au lot D. Par défaut : la vraie fonction. */
  enregistrer?: typeof enregistrerConversion;
  maintenant?: () => Date;
  fenetreHeures?: number;
  limite?: number;
  /** Restreindre à un site, pour un diagnostic. */
  siteId?: number;
}

function lignesDe(resultat: unknown): Record<string, unknown>[] {
  if (Array.isArray(resultat)) return resultat as Record<string, unknown>[];
  const rows = (resultat as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * Sites dont les réglages Ads sont ACTIVÉS.
 *
 * Le filtre est ici, en SQL, et pas seulement dans le drain : un site désactivé
 * ne doit produire aucune ligne de journal, pas même une ligne qui serait écartée
 * ensuite. Autrement l'activation d'un site ferait partir d'un coup tout
 * l'historique accumulé pendant qu'il était éteint.
 */
async function sitesActives(base: BaseOutbox, siteId?: number): Promise<number[]> {
  const resultat =
    siteId === undefined
      ? await base.execute(sql`SELECT site_id FROM ads_site_settings WHERE enabled = true ORDER BY site_id`)
      : await base.execute(
          sql`SELECT site_id FROM ads_site_settings WHERE enabled = true AND site_id = ${siteId} ORDER BY site_id`,
        );
  return lignesDe(resultat).map(l => Number(l.site_id));
}

/** Correspondances « nom d'événement → action de conversion » d'un site. */
async function correspondancesDe(base: BaseOutbox, siteId: number): Promise<Map<string, string>> {
  const resultat = await base.execute(
    sql`SELECT event_name, conversion_action_id FROM ads_conversion_mappings WHERE site_id = ${siteId}`,
  );
  const carte = new Map<string, string>();
  for (const l of lignesDe(resultat)) carte.set(String(l.event_name), String(l.conversion_action_id));
  return carte;
}

/**
 * Identifiants métier déjà au journal sur la fenêtre balayée.
 *
 * C'est l'optimisation qui rend la fenêtre glissante abordable : sans elle,
 * chaque passage relancerait une recherche d'identifiant de clic — une requête
 * ClickHouse par événement — pour des conversions déjà inscrites. Elle ne change
 * RIEN à la correction : `enregistrerConversion` est idempotent de toute façon,
 * et un test le vérifie en la court-circuitant.
 *
 * La borne basse est reculée d'une heure sous la fenêtre : `occurred_at` est
 * l'horodatage de l'événement, donc exactement la borne du balayage, et une
 * comparaison stricte sur la même valeur est le genre de détail qui laisse
 * passer la ligne pile à la frontière.
 */
async function identifiantsDejaAuJournal(base: BaseOutbox, siteId: number, depuis: Date): Promise<Set<string>> {
  const borne = new Date(depuis.getTime() - 3_600_000).toISOString();
  const resultat = await base.execute(sql`
    SELECT business_event_id FROM ads_conversion_outbox
     WHERE site_id = ${siteId} AND occurred_at >= ${borne}::timestamp
  `);
  return new Set(lignesDe(resultat).map(l => String(l.business_event_id)));
}

/**
 * Écrit le bilan du passage pour un site. Un enregistrement, écrasé à chaque fois.
 *
 * 🔴 Appelé même quand le site n'a RIEN produit — c'est tout l'intérêt. Un
 * passage qui n'inscrit rien doit laisser une trace, sinon « le balayage a
 * tourné et tout écarté » reste indistinguable de « le balayage n'a jamais
 * tourné », qui est le témoin d'une tâche planifiée morte.
 *
 * ⚠️ `last_run_at` est posé EXPLICITEMENT, jamais par un `DEFAULT now()` : celui-ci
 * écrit l'heure murale de la SESSION Postgres dans une colonne sans fuseau. Sur
 * une base réglée ailleurs qu'en UTC, l'écran afficherait un dernier passage
 * dans le futur, sans qu'aucune erreur ne l'explique. Même convention, et même
 * raison, que `ads_conversion_outbox`.
 *
 * Cette écriture est best-effort : si elle échoue, le balayage a QUAND MÊME fait
 * son travail, et le perdre serait pire que perdre son compte rendu.
 */
export async function enregistrerBilanSite(
  base: BaseOutbox,
  siteId: number,
  bilan: BilanBalayage,
  maintenant: Date,
): Promise<void> {
  try {
    await base.execute(sql`
      INSERT INTO ads_scan_state (
        site_id, last_run_at, events_examined, recorded, already_known, duplicates,
        skipped_no_consent, skipped_no_click, errors, truncated,
        unmapped_events, unmapped_top_names, updated_at
      ) VALUES (
        ${siteId}, ${versColonne(maintenant)}::timestamp,
        ${bilan.evenements}, ${bilan.inscrits}, ${bilan.dejaConnus}, ${bilan.doublons},
        ${bilan.ignoresSansConsentement}, ${bilan.ignoresSansClic}, ${bilan.erreurs},
        ${bilan.tronques > 0},
        ${bilan.nonMappes}, ${bilan.nomsNonMappes.join(", ") || null},
        ${versColonne(maintenant)}::timestamp
      )
      ON CONFLICT (site_id) DO UPDATE SET
        last_run_at = EXCLUDED.last_run_at,
        events_examined = EXCLUDED.events_examined,
        recorded = EXCLUDED.recorded,
        already_known = EXCLUDED.already_known,
        duplicates = EXCLUDED.duplicates,
        skipped_no_consent = EXCLUDED.skipped_no_consent,
        skipped_no_click = EXCLUDED.skipped_no_click,
        errors = EXCLUDED.errors,
        truncated = EXCLUDED.truncated,
        unmapped_events = EXCLUDED.unmapped_events,
        unmapped_top_names = EXCLUDED.unmapped_top_names,
        updated_at = EXCLUDED.updated_at
    `);
  } catch (erreur) {
    logger.error({ siteId, err: (erreur as Error).message }, "Bilan de balayage non enregistré");
  }
}

/**
 * Balaye UN site. Chaque événement est traité indépendamment : une conversion qui
 * échoue (attribution en panne, écriture refusée) n'emporte pas les suivantes.
 *
 * Toute erreur non rattrapée ici remonte à `balayerConversions`, qui isole le
 * site et poursuit avec les autres.
 */
export async function balayerSite(
  siteId: number,
  deps: DependancesBalayage,
  maintenant: Date,
): Promise<BilanBalayage> {
  const base = deps.base ?? (dbParDefaut as unknown as BaseOutbox);
  const bilanFinal: BilanBalayage = { ...BILAN_VIDE, sites: 1 };
  try {
    const observe = await examinerSite(siteId, deps, maintenant);
    Object.assign(bilanFinal, observe);
    return bilanFinal;
  } catch (erreur) {
    // Le site a échoué (ClickHouse, base). On compte l'erreur ET on écrit le
    // bilan quand même : sans cela un site en panne permanente resterait
    // « jamais tourné », donc confondu avec une tâche planifiée morte.
    bilanFinal.erreurs += 1;
    throw erreur;
  } finally {
    // 🔴 Dans un `finally` : le bilan s'écrit sur TOUS les chemins de sortie —
    // aucune correspondance, aucun événement, panne. Un retour anticipé qui
    // sauterait l'écriture recréerait exactement le trou qu'on bouche.
    await enregistrerBilanSite(base, siteId, bilanFinal, maintenant);
  }
}

/** Le travail proprement dit. Séparé pour que `balayerSite` puisse écrire son bilan sur tous les chemins. */
async function examinerSite(
  siteId: number,
  deps: DependancesBalayage,
  maintenant: Date,
): Promise<BilanBalayage> {
  const base = deps.base ?? (dbParDefaut as unknown as BaseOutbox);
  const lireEvenements = deps.lireEvenements ?? (spec => runAnalyticsQuery<EvenementMetier>(spec));
  const attribuer = deps.attribuer ?? retrouverIdentifiantClic;
  const enregistrer = deps.enregistrer ?? enregistrerConversion;
  const limite = deps.limite ?? LIMITE_EVENEMENTS;

  const compterNonMappes = deps.compterNonMappes ?? (spec => runAnalyticsQuery<LigneNonMappee>(spec));

  const bilan: BilanBalayage = { ...BILAN_VIDE, sites: 1 };

  const correspondances = await correspondancesDe(base, siteId);
  const noms = [...correspondances.keys()];

  const fenetreHeures = deps.fenetreHeures ?? FENETRE_RATTRAPAGE_HEURES;
  const debut = new Date(maintenant.getTime() - fenetreHeures * 3_600_000);

  // 🔴 Le comptage des non-couverts tourne D'ABORD, et même quand le site n'a
  // aucune correspondance — c'est précisément le cas le plus cassé. C'est le
  // seul chiffre capable de distinguer « ce site n'émet rien » de « ce site
  // émet, sous des noms que personne n'a saisis ».
  try {
    const nonMappes = await compterNonMappes(construireRequeteNonMappes({ siteId, noms, debut, fin: maintenant }));
    bilan.nonMappes = nonMappes.reduce((total, l) => total + Number(l.n ?? 0), 0);
    bilan.nomsNonMappes = nonMappes.map(l => String(l.eventName));
  } catch (erreur) {
    // Un diagnostic manquant ne doit pas empêcher le balayage de faire son
    // travail : c'est un confort, pas une dépendance.
    logger.warn({ siteId, err: (erreur as Error).message }, "Comptage des événements non couverts en échec");
  }

  // Aucune correspondance : le site est activé mais rien n'est câblé. Interroger
  // ClickHouse avec une liste de noms vide ne rendrait rien, autant l'éviter.
  if (correspondances.size === 0) return bilan;

  const evenements = await lireEvenements(
    construireRequeteEvenements({ siteId, noms, debut, fin: maintenant, limite }),
  );
  bilan.evenements = evenements.length;
  if (evenements.length === 0) return bilan;

  if (evenements.length >= limite) {
    bilan.tronques = 1;
    logger.warn(
      { siteId, limite, fenetreHeures },
      "Balayage tronqué : il reste des événements non vus sur la fenêtre. Élargir la limite ou resserrer la cadence.",
    );
  }

  const deja = await identifiantsDejaAuJournal(base, siteId, debut);
  const vusDansLeLot = new Set<string>();

  for (const evenement of evenements) {
    const conversionActionId = correspondances.get(evenement.eventName);
    if (!conversionActionId) continue; // ceinture : la requête filtre déjà sur les noms

    const businessEventId = identifiantEvenementMetier(evenement);

    if (deja.has(businessEventId)) {
      bilan.dejaConnus += 1;
      continue;
    }
    if (vusDansLeLot.has(businessEventId)) {
      // Deux lignes ClickHouse identiques : un double envoi du traceur, ou deux
      // achats réellement indiscernables. Dans les deux cas, une seule conversion.
      bilan.doublons += 1;
      continue;
    }
    vusDansLeLot.add(businessEventId);

    const props = lireProps(evenement.props);
    const consentement = lireConsentement(props);
    if (consentement.adUserData !== "CONSENT_GRANTED") {
      // Ni attribution, ni écriture : on ne STOCKE pas un identifiant
      // publicitaire rattaché à quelqu'un qui n'a pas consenti.
      bilan.ignoresSansConsentement += 1;
      continue;
    }

    const occurredAt = new Date(evenement.horodatage);
    if (Number.isNaN(occurredAt.getTime())) {
      logger.warn({ siteId, horodatage: evenement.horodatage }, "Horodatage d'événement illisible, ignoré");
      bilan.erreurs += 1;
      continue;
    }

    try {
      // 🔴 LA couture. C'est cet appel, et celui d'`enregistrer` juste dessous,
      // qui n'existaient nulle part avant ce fichier.
      const attribution = await attribuer({
        siteId,
        utilisateur: evenement.utilisateur,
        conversionAt: occurredAt,
      });

      if (!attribution.identifiant) {
        // Le cas MAJORITAIRE : tout le trafic non payant. Ce n'est pas une erreur.
        bilan.ignoresSansClic += 1;
        continue;
      }

      const valeur = lireValeur(props);
      const resultat = await enregistrer(
        {
          siteId,
          businessEventId,
          conversionActionId,
          eventName: evenement.eventName,
          clickIdType: attribution.identifiant.type,
          clickId: attribution.identifiant.valeur,
          occurredAt,
          clickAt: new Date(attribution.identifiant.horodatage),
          // `undefined` déclenche le repli sur la correspondance, `null` ne le
          // déclencherait pas : on ne prononce jamais `null` ici.
          value: valeur.value,
          currency: valeur.currency,
          consentAdUserData: consentement.adUserData,
          consentAdPersonalization: consentement.adPersonalization,
        },
        base,
        maintenant,
      );

      if (resultat.cree) bilan.inscrits += 1;
      else bilan.dejaConnus += 1;
    } catch (erreur) {
      // Best-effort : un événement qui casse ne fait pas tomber le site, et le
      // passage suivant le retentera puisque rien n'a été écrit pour lui.
      bilan.erreurs += 1;
      logger.error(
        { siteId, businessEventId, err: (erreur as Error).message },
        "Événement métier non converti : il sera retenté au prochain passage",
      );
    }
  }

  return bilan;
}

function cumuler(total: BilanBalayage, part: BilanBalayage): BilanBalayage {
  for (const cle of Object.keys(total) as (keyof BilanBalayage)[]) {
    if (cle === "nomsNonMappes") total.nomsNonMappes = [...total.nomsNonMappes, ...part.nomsNonMappes];
    else (total[cle] as number) += part[cle] as number;
  }
  return total;
}

/**
 * Un passage complet : tous les sites activés.
 *
 * 🔴 Best-effort de bout en bout. Un site dont ClickHouse répond mal est compté
 * en erreur et le passage CONTINUE : la panne d'un site ne prive pas les dix-sept
 * autres de leurs conversions, et le passage suivant rattrapera le premier —
 * c'est précisément ce que la fenêtre glissante sans curseur rend possible.
 */
export async function balayerConversions(deps: DependancesBalayage = {}): Promise<BilanBalayage> {
  const base = deps.base ?? (dbParDefaut as unknown as BaseOutbox);
  const maintenant = (deps.maintenant ?? (() => new Date()))();

  const sites = await sitesActives(base, deps.siteId);
  const total: BilanBalayage = { ...BILAN_VIDE };

  for (const siteId of sites) {
    try {
      cumuler(total, await balayerSite(siteId, deps, maintenant));
    } catch (erreur) {
      total.sites += 1;
      total.erreurs += 1;
      logger.error({ siteId, err: (erreur as Error).message }, "Balayage du site en échec, passage poursuivi");
    }
  }

  if (total.ignoresSansConsentement > 0 && total.inscrits === 0) {
    // Le seul état qui ressemble à une panne sans en être une, et qui autrement
    // ne se verrait nulle part : le traceur du site n'émet pas le consentement.
    logger.warn(
      { ignores: total.ignoresSansConsentement },
      "Aucune conversion inscrite : tous les événements mappés sont sans consentement publicitaire. " +
        "Vérifier que le traceur émet ads_consent_ad_user_data.",
    );
  }

  return total;
}

/* ─────────────────────────── Service planifié ───────────────────────────── */

/**
 * Le balayage planifié, sur le patron d'`AdsOutboxService`.
 */
class AdsScanService {
  private tache: cron.ScheduledTask | null = null;
  private logger = createServiceLogger("ads-balayage-cron");
  /** Empêche deux passages de se chevaucher DANS le même processus. */
  private enCours = false;

  private initialiser() {
    // 🔴 Le garde qui compte. `CLUSTER_WORKERS` vaut 4 en production : sans lui,
    // quatre processus balaient les mêmes événements en même temps. Rien ne
    // serait compté deux fois (la clé d'unicité tient), mais on paierait quatre
    // fois les requêtes ClickHouse — la partie chère — sans qu'aucune erreur ne
    // le signale.
    if (cluster.isWorker) {
      this.logger.debug("Balayage Ads non planifié sur un worker de cluster");
      return;
    }

    this.tache = cron.schedule(
      CADENCE_BALAYAGE,
      async () => {
        if (this.enCours) {
          this.logger.warn("Passage de balayage sauté : le précédent n'est pas terminé");
          return;
        }
        this.enCours = true;
        try {
          const bilan = await balayerConversions();
          if (bilan.evenements > 0) this.logger.info(bilan, "Passage de balayage terminé");
        } catch (error) {
          this.logger.error(error as Error, "Erreur pendant le balayage des conversions Ads");
        } finally {
          this.enCours = false;
        }
      },
      { timezone: "UTC" },
    );

    this.logger.info(`Balayage des conversions Ads planifié (${CADENCE_BALAYAGE})`);
  }

  public startAdsScanCron() {
    this.initialiser();
  }

  public stopAdsScanCron() {
    if (this.tache) {
      this.tache.stop();
      this.tache = null;
      this.logger.info("Balayage des conversions Ads arrêté");
    }
  }

  /** Un passage immédiat, pour les diagnostics et les tests de bout en bout. */
  public async balayerMaintenant(deps: DependancesBalayage = {}): Promise<BilanBalayage> {
    return balayerConversions(deps);
  }
}

export const adsScanService = new AdsScanService();
