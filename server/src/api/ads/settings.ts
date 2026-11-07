/**
 * Réglages Google Ads d'un site : quel compte, activé ou non, mode d'essai, et
 * la table des correspondances « événement métier → action de conversion ».
 *
 * Ce fichier ne parle ni à Google ni au journal d'envoi : il ne fait que lire et
 * écrire du réglage, plus un état de santé qui LIT `ads_conversion_outbox` sans
 * jamais l'écrire (le journal appartient au drain, lot D).
 *
 * 🔴 Aucun secret ne transite par ici. La conception du 2026-08-29 (décision
 * n°1) a écarté l'OAuth par site : les identifiants du compte administrateur
 * vivent dans la configuration serveur, et un site ne porte QUE « quel compte
 * Ads ». Il n'y a donc rien à chiffrer, rien à masquer dans une réponse — et
 * rien de ce fichier ne doit jamais lire les variables d'environnement du
 * compte administrateur. Un test le vérifie sur
 * le texte source, parce qu'une régression ici ne se verrait pas autrement.
 *
 * Pourquoi valider AVANT la base alors que le schéma porte déjà des `CHECK` :
 * une contrainte Postgres qui mord remonte en 500 avec un message d'erreur SQL.
 * Ce n'est pas une validation, c'est une panne. Les contrôles ci-dessous
 * refusent les deux fautes réellement probables — le compte au format à tirets
 * de l'interface Google, et l'étiquette de tag `AW-.../...` collée à la place
 * d'un identifiant d'action — avec un message qui dit quoi saisir. Le `CHECK`
 * reste le filet, il ne doit simplement jamais être le premier à parler.
 */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db/postgres/postgres.js";
import { adsConversionMappings, adsConversionOutbox, adsScanState, adsSiteSettings } from "../../db/postgres/schema.js";

/** Résultat d'une validation : soit la valeur normalisée, soit un message pour l'utilisateur. */
export type Validation = { ok: true; valeur: string } | { ok: false; message: string };

/** Un identifiant de compte Google Ads est un nombre nu. Les comptes réels font 10 chiffres. */
const MOTIF_NOMBRE = /^\d+$/;

/**
 * L'étiquette du tag de site, de la forme `AW-18413758700/cL48CMKl_OkcEOzRrsxE`.
 * Elle existe pour de bon sur le compte ASD et se copie depuis la même page que
 * l'identifiant d'action : quelqu'un la collera. Sans ce cas nommé, elle
 * tomberait dans le message générique et ferait chercher au mauvais endroit.
 */
const MOTIF_ETIQUETTE_TAG = /^AW-\d+\/\S+$/i;

/** Forme longue rendue par l'API Ads : `customers/123/conversionActions/456`. */
const MOTIF_RESOURCE_NAME = /^customers\/\d+\/conversionActions\/(\d+)$/;

/**
 * Identifiant de compte. Le format à tirets est refusé plutôt que nettoyé en
 * silence : c'est un compte qui reçoit de l'argent publicitaire, et une saisie
 * qu'on corrige sans le dire est une saisie qu'on ne relit jamais. Le message
 * porte la valeur exacte à coller, donc le refus ne coûte qu'un aller-retour.
 */
export function validerCompteAds(brut: unknown): Validation {
  if (typeof brut !== "string" || brut.trim() === "") {
    return { ok: false, message: "L'identifiant du compte Google Ads est obligatoire." };
  }
  const valeur = brut.trim();

  if (/^[\d-]+$/.test(valeur) && valeur.includes("-")) {
    const sansTirets = valeur.replace(/-/g, "");
    return {
      ok: false,
      message: `L'identifiant du compte Google Ads s'écrit sans tirets : saisir « ${sansTirets} » et non « ${valeur} ».`,
    };
  }

  if (!MOTIF_NOMBRE.test(valeur)) {
    return {
      ok: false,
      message: `Identifiant de compte Google Ads invalide : « ${valeur} ». Attendu : un nombre sans tirets, par exemple 2568911678.`,
    };
  }

  // Borne de longueur : un compte Ads fait 10 chiffres. Un « 1 » ou un numéro de
  // téléphone passeraient le `CHECK` de la base et n'échoueraient qu'au premier
  // envoi, en 403, plusieurs heures plus tard.
  if (valeur.length < 8 || valeur.length > 12) {
    return {
      ok: false,
      message: `Identifiant de compte Google Ads invraisemblable : « ${valeur} » (${valeur.length} chiffres, un compte en fait 10).`,
    };
  }

  return { ok: true, valeur };
}

/**
 * Identifiant d'action de conversion. Tolérant sur la forme longue de l'API
 * (`customers/…/conversionActions/456`), qu'on normalise puisqu'elle est sans
 * ambiguïté ; strict sur tout le reste.
 */
export function validerActionConversion(brut: unknown): Validation {
  if (typeof brut !== "string" || brut.trim() === "") {
    return { ok: false, message: "L'identifiant de l'action de conversion est obligatoire." };
  }
  const valeur = brut.trim();

  if (MOTIF_ETIQUETTE_TAG.test(valeur)) {
    return {
      ok: false,
      message:
        `« ${valeur} » est une étiquette du tag de site (AW-…/…), pas un identifiant d'action de conversion. ` +
        `L'identifiant attendu est le nombre affiché dans l'URL de l'action dans Google Ads (paramètre ctId).`,
    };
  }

  const resourceName = valeur.match(MOTIF_RESOURCE_NAME);
  if (resourceName) {
    return { ok: true, valeur: resourceName[1] };
  }

  if (!MOTIF_NOMBRE.test(valeur)) {
    return {
      ok: false,
      message: `Identifiant d'action de conversion invalide : « ${valeur} ». Attendu : un identifiant numérique.`,
    };
  }

  return { ok: true, valeur };
}

/** Nom d'événement métier tel qu'il est ingéré (`order_paid`). */
export function validerNomEvenement(brut: unknown): Validation {
  if (typeof brut !== "string" || brut.trim() === "") {
    return { ok: false, message: "Le nom de l'événement est obligatoire." };
  }
  const valeur = brut.trim();
  if (valeur.length > 128) {
    return { ok: false, message: "Le nom de l'événement dépasse 128 caractères." };
  }
  return { ok: true, valeur };
}

/**
 * Devise ISO 4217. Mesuré le 2026-08-29 : Google rend un 400 sur une devise
 * inconnue, donc la laisser passer condamne la conversion à échouer une fois
 * dans le journal, là où le contrôle ici coûte trois lignes.
 */
export function validerDevise(brut: unknown): Validation {
  if (brut === undefined || brut === null || brut === "") {
    return { ok: true, valeur: "EUR" };
  }
  if (typeof brut !== "string" || !/^[A-Za-z]{3}$/.test(brut.trim())) {
    return { ok: false, message: `Devise invalide : « ${String(brut)} ». Attendu : un code ISO 4217, par exemple EUR.` };
  }
  return { ok: true, valeur: brut.trim().toUpperCase() };
}

/**
 * Valeur par défaut d'une conversion. Rendue en chaîne : la colonne est
 * `numeric(14,2)` et une valeur monétaire ne se promène pas en flottant.
 */
export function validerValeurParDefaut(brut: unknown): { ok: true; valeur: string | null } | { ok: false; message: string } {
  if (brut === undefined || brut === null || brut === "") {
    return { ok: true, valeur: null };
  }
  const nombre = typeof brut === "number" ? brut : Number(String(brut).trim());
  if (!Number.isFinite(nombre) || nombre < 0) {
    return { ok: false, message: `Valeur par défaut invalide : « ${String(brut)} ». Attendu : un montant positif.` };
  }
  if (nombre > 99_999_999_999.99) {
    return { ok: false, message: "Valeur par défaut hors bornes (colonne numeric(14,2))." };
  }
  return { ok: true, valeur: nombre.toFixed(2) };
}

/**
 * Ce qu'une route a le droit de rendre. Projection EXPLICITE plutôt qu'un
 * `select()` étalé tel quel : le jour où une colonne sensible apparaît dans la
 * table, elle ne sortira pas d'elle-même par l'API.
 */
export interface ReglagesAds {
  siteId: number;
  customerId: string;
  enabled: boolean;
  testMode: boolean;
  createdAt: string;
  updatedAt: string;
}

const COLONNES_REGLAGES = {
  siteId: adsSiteSettings.siteId,
  customerId: adsSiteSettings.customerId,
  enabled: adsSiteSettings.enabled,
  testMode: adsSiteSettings.testMode,
  createdAt: adsSiteSettings.createdAt,
  updatedAt: adsSiteSettings.updatedAt,
};

export async function lireReglages(siteId: number): Promise<ReglagesAds | null> {
  const [ligne] = await db.select(COLONNES_REGLAGES).from(adsSiteSettings).where(eq(adsSiteSettings.siteId, siteId));
  return ligne ?? null;
}

export interface EntreeReglages {
  customerId?: unknown;
  enabled?: unknown;
  testMode?: unknown;
}

/**
 * Écrit les réglages d'un site. Création ou mise à jour, sans distinction pour
 * l'appelant : « quel compte Ads pour ce site » est un fait unique, pas une
 * ressource qu'on créerait puis modifierait. D'où un PUT idempotent.
 *
 * Les champs absents sont laissés en l'état — un appel qui ne porte que
 * `enabled` ne doit pas réinitialiser le mode d'essai.
 */
export async function enregistrerReglages(
  siteId: number,
  entree: EntreeReglages
): Promise<{ ok: true; reglages: ReglagesAds } | { ok: false; message: string }> {
  const existant = await lireReglages(siteId);

  let customerId = existant?.customerId;
  if (entree.customerId !== undefined) {
    const validation = validerCompteAds(entree.customerId);
    if (!validation.ok) return validation;
    customerId = validation.valeur;
  }
  if (!customerId) {
    return { ok: false, message: "L'identifiant du compte Google Ads est obligatoire à la première configuration." };
  }

  const enabled = lireBooleen(entree.enabled, existant?.enabled ?? false);
  if (enabled === null) return { ok: false, message: "Le champ « enabled » doit être un booléen." };
  const testMode = lireBooleen(entree.testMode, existant?.testMode ?? false);
  if (testMode === null) return { ok: false, message: "Le champ « testMode » doit être un booléen." };

  const maintenant = new Date().toISOString();
  const [ligne] = await db
    .insert(adsSiteSettings)
    .values({ siteId, customerId, enabled, testMode, updatedAt: maintenant })
    .onConflictDoUpdate({
      target: adsSiteSettings.siteId,
      set: { customerId, enabled, testMode, updatedAt: maintenant },
    })
    .returning(COLONNES_REGLAGES);

  return { ok: true, reglages: ligne };
}

function lireBooleen(brut: unknown, defaut: boolean): boolean | null {
  if (brut === undefined) return defaut;
  if (typeof brut === "boolean") return brut;
  return null;
}

export interface CorrespondanceAds {
  id: number;
  eventName: string;
  conversionActionId: string;
  defaultValue: string | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

const COLONNES_CORRESPONDANCE = {
  id: adsConversionMappings.id,
  eventName: adsConversionMappings.eventName,
  conversionActionId: adsConversionMappings.conversionActionId,
  defaultValue: adsConversionMappings.defaultValue,
  currency: adsConversionMappings.currency,
  createdAt: adsConversionMappings.createdAt,
  updatedAt: adsConversionMappings.updatedAt,
};

export async function listerCorrespondances(siteId: number): Promise<CorrespondanceAds[]> {
  return db
    .select(COLONNES_CORRESPONDANCE)
    .from(adsConversionMappings)
    .where(eq(adsConversionMappings.siteId, siteId))
    .orderBy(adsConversionMappings.eventName);
}

export interface EntreeCorrespondance {
  eventName?: unknown;
  conversionActionId?: unknown;
  defaultValue?: unknown;
  currency?: unknown;
}

/**
 * Crée une correspondance. Un doublon d'événement est refusé plutôt qu'écrasé :
 * l'unicité `(site, événement)` existe pour empêcher qu'un achat soit compté
 * deux fois, et écraser en silence ferait disparaître une action de conversion
 * du réglage sans que personne ne l'ait demandé.
 */
export async function creerCorrespondance(
  siteId: number,
  entree: EntreeCorrespondance
): Promise<{ ok: true; correspondance: CorrespondanceAds } | { ok: false; message: string; conflit?: true }> {
  const nom = validerNomEvenement(entree.eventName);
  if (!nom.ok) return nom;

  const action = validerActionConversion(entree.conversionActionId);
  if (!action.ok) return action;

  const devise = validerDevise(entree.currency);
  if (!devise.ok) return devise;

  const valeur = validerValeurParDefaut(entree.defaultValue);
  if (!valeur.ok) return valeur;

  const [deja] = await db
    .select({ conversionActionId: adsConversionMappings.conversionActionId })
    .from(adsConversionMappings)
    .where(and(eq(adsConversionMappings.siteId, siteId), eq(adsConversionMappings.eventName, nom.valeur)));
  if (deja) {
    return {
      ok: false,
      conflit: true,
      message: `L'événement « ${nom.valeur} » est déjà associé à l'action ${deja.conversionActionId}. Supprimer la correspondance existante avant d'en créer une autre.`,
    };
  }

  const [ligne] = await db
    .insert(adsConversionMappings)
    .values({
      siteId,
      eventName: nom.valeur,
      conversionActionId: action.valeur,
      defaultValue: valeur.valeur,
      currency: devise.valeur,
    })
    .returning(COLONNES_CORRESPONDANCE);

  return { ok: true, correspondance: ligne };
}

/**
 * Supprime une correspondance. Le `site_id` est DANS la clause, pas seulement
 * dans la garde d'autorisation : un identifiant de correspondance est un entier
 * qui se devine, et cette double condition rend structurellement impossible
 * d'effacer le réglage d'un autre site, même si la garde venait à céder.
 */
export async function supprimerCorrespondance(siteId: number, id: number): Promise<boolean> {
  const supprimees = await db
    .delete(adsConversionMappings)
    .where(and(eq(adsConversionMappings.siteId, siteId), eq(adsConversionMappings.id, id)))
    .returning({ id: adsConversionMappings.id });
  return supprimees.length > 0;
}

/**
 * Ce que le dernier passage du balayage a vu. `null` quand il n'a jamais tourné.
 *
 * Cette lecture est ADDITIVE : `etatSante` est consommé par trois surfaces
 * clientes, et sa forme existante n'est pas touchée.
 */
export interface DernierBalayage {
  /** Heure murale UTC du passage. */
  at: string;
  /** Événements MAPPÉS lus. Zéro = site calme ; non nul avec `recorded` à zéro = configuration cassée. */
  examined: number;
  recorded: number;
  alreadyKnown: number;
  duplicates: number;
  /** Écartés faute de consentement publicitaire : n'entrent JAMAIS dans le journal. */
  skippedNoConsent: number;
  /** Écartés faute d'identifiant de clic dans la fenêtre : le cas majoritaire, non payant. */
  skippedNoClick: number;
  errors: number;
  /** La limite par passage a mordu : des événements de la fenêtre n'ont pas été vus. */
  truncated: boolean;
  /** Événements personnalisés qu'AUCUNE correspondance ne couvre. */
  unmappedEvents: number;
  /** Les plus fréquents d'entre eux : « voici ce que ton site émet réellement ». */
  unmappedTopNames: string[];
}

/**
 * Le verdict du balayage, en un mot.
 *
 * 🔴 Il existe pour une seule raison : trois situations produisaient jusqu'ici
 * le MÊME écran, « 0 en attente, 0 envoyé ».
 *
 *  - `never_ran`     le balayage n'a jamais tourné. C'est le témoin d'une tâche
 *                    planifiée morte, qui n'en a aucun autre — un cron qui ne
 *                    démarre pas ne lève rien, n'écrit rien, et ressemble en tout
 *                    point à un système au repos ;
 *  - `no_mappings`   activé, mais aucun événement n'est associé à une action de
 *                    conversion. Rien ne peut sortir, par construction ;
 *  - `idle`          il a tourné et n'a vu aucun événement. Site calme, RAS ;
 *  - `all_discarded` il a vu du trafic d'événements et n'en a tiré AUCUNE
 *                    conversion. C'est une configuration à regarder, et c'est
 *                    l'état qui se déguisait en site calme ;
 *  - `producing`     il inscrit des conversions.
 *
 * `never_ran` passe devant `no_mappings` : un site sans correspondance se répare
 * en trois clics, une tâche planifiée qui ne tourne pas empêche TOUS les sites de
 * produire. Le plus grave d'abord.
 */
export type VerdictBalayage = "never_ran" | "no_mappings" | "idle" | "all_discarded" | "producing";

/** Fonction PURE : elle rend le verdict testable sans base. */
export function classerBalayage(dernier: DernierBalayage | null, mappings: number): VerdictBalayage {
  if (!dernier) return "never_ran";
  if (mappings === 0) return "no_mappings";
  // Le trafic vu, c'est le mappé ET le non couvert : un site qui n'émet que des
  // noms non mappés a bien du trafic, et c'est même le cas le plus cassé.
  const vus = dernier.examined + dernier.unmappedEvents;
  if (vus === 0) return "idle";
  return dernier.recorded === 0 ? "all_discarded" : "producing";
}

export interface EtatSanteAds {
  configured: boolean;
  enabled: boolean;
  testMode: boolean;
  customerId: string | null;
  mappings: number;
  pending: number;
  sent: number;
  failed: number;
  // Écartées par une règle métier (consentement, fenêtre de 90 jours, mode
  // d'essai). Distinct de `failed` : rien n'est cassé, on a décidé de ne pas
  // envoyer. Sans ce compteur, les trois précédents ne totalisent pas la file.
  skipped: number;
  // 🔴 Conversions ENVOYÉES à valeur nulle ou absente. Google les accepte et les
  // compte : le ROAS du compte devient faux sans qu'aucun compteur d'erreur ne
  // bouge, et c'est le seul défaut du module qu'aucun contrôle d'envoi ne peut
  // attraper — le message est parfaitement valide. Un chiffre qui monte ici
  // veut dire : une correspondance n'a pas de valeur par défaut, ou l'appelant
  // n'en fournit pas. Une conversion sans montant reste légitime (formulaire de
  // contact), d'où un compteur et non un blocage.
  zeroValueSent: number;
  lastError: { message: string; at: string } | null;
  lastSentAt: string | null;
  oldestPendingAt: string | null;
  // 🔴 Retard maximal, EN SECONDES, sur l'échéance d'une ligne en attente.
  // `null` quand aucune n'est en retard.
  //
  // C'est le seul témoin fiable d'un drain arrêté, et il ne se confond avec
  // rien. L'ancienneté d'une ligne ne dit RIEN : le report exponentiel du drain
  // monte à 6 h et le budget d'essais couvre douze heures, donc une conversion
  // peut légitimement attendre une demi-journée. Une échéance DÉPASSÉE, alors
  // que le drain passe toutes les deux minutes, ne peut vouloir dire qu'une
  // chose : personne ne draine.
  //
  // En secondes calculées côté serveur, et pas en date ISO : le navigateur
  // devrait sinon comparer à sa propre horloge, et un poste mal réglé
  // fabriquerait une alerte ou en masquerait une, silencieusement.
  oldestOverdueBy: number | null;
  // 🔴 Ce que le DERNIER balayage a vu, et son verdict. Ajout du lot G.
  //
  // Sans eux, les compteurs ci-dessus ne peuvent rien dire d'un site dont chaque
  // événement est écarté AVANT d'entrer au journal — consentement absent, nom
  // d'événement non couvert, aucun clic. Ils affichent alors « 0 en attente,
  // 0 envoyé », c'est-à-dire l'écran d'un site sans trafic.
  lastScan: DernierBalayage | null;
  scanVerdict: VerdictBalayage;
}

/**
 * État de santé lisible. Il répond à la seule question qui se pose vraiment
 * devant ce module : « est-ce que ça part, et sinon pourquoi ».
 *
 * `oldestPendingAt` est le témoin qui manque partout ailleurs : un drain arrêté
 * ne produit AUCUNE erreur — la file grossit, tout est « pending », et rien ne
 * distingue cet état d'un site simplement calme. Une échéance dépassée depuis
 * des heures, elle, se voit.
 *
 * Cette fonction LIT le journal du lot D et ne l'écrit jamais.
 */
export async function etatSante(siteId: number): Promise<EtatSanteAds> {
  const [
    reglages,
    correspondances,
    parEtat,
    dernierEchec,
    dernierEnvoi,
    plusVieuxEnAttente,
    envoyeesSansValeur,
    retardEcheance,
    dernierBalayage,
  ] = await Promise.all([
    lireReglages(siteId),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(adsConversionMappings)
      .where(eq(adsConversionMappings.siteId, siteId)),
    db
      .select({ status: adsConversionOutbox.status, n: sql<number>`count(*)::int` })
      .from(adsConversionOutbox)
      .where(eq(adsConversionOutbox.siteId, siteId))
      .groupBy(adsConversionOutbox.status),
    db
      .select({ lastError: adsConversionOutbox.lastError, updatedAt: adsConversionOutbox.updatedAt })
      .from(adsConversionOutbox)
      .where(and(eq(adsConversionOutbox.siteId, siteId), isNotNull(adsConversionOutbox.lastError)))
      .orderBy(desc(adsConversionOutbox.updatedAt))
      .limit(1),
    db
      .select({ sentAt: adsConversionOutbox.sentAt })
      .from(adsConversionOutbox)
      .where(and(eq(adsConversionOutbox.siteId, siteId), isNotNull(adsConversionOutbox.sentAt)))
      .orderBy(desc(adsConversionOutbox.sentAt))
      .limit(1),
    db
      .select({ createdAt: adsConversionOutbox.createdAt })
      .from(adsConversionOutbox)
      .where(and(eq(adsConversionOutbox.siteId, siteId), eq(adsConversionOutbox.status, "pending")))
      .orderBy(adsConversionOutbox.createdAt)
      .limit(1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(adsConversionOutbox)
      .where(
        and(
          eq(adsConversionOutbox.siteId, siteId),
          eq(adsConversionOutbox.status, "sent"),
          sql`(${adsConversionOutbox.value} IS NULL OR ${adsConversionOutbox.value} = 0)`
        )
      ),
      // ⚠️ `now() AT TIME ZONE 'UTC'`, jamais `now()` nu. La colonne est un
      // `timestamp` SANS fuseau qui contient de l'heure UTC ; comparer un
      // `timestamptz` avec elle le convertit implicitement dans le fuseau de la
      // SESSION. Sous une base réglée sur Europe/Paris, toutes les lignes
      // paraîtraient deux heures en retard et l'alerte hurlerait en permanence,
      // sans qu'aucune erreur ne l'explique. L'ancrage rend le calcul
      // indépendant du réglage de la base.
      db
        .select({
          retard: sql<
            number | null
          >`max(extract(epoch from ((now() AT TIME ZONE 'UTC') - ${adsConversionOutbox.nextAttemptAt})))::int`,
        })
        .from(adsConversionOutbox)
        .where(
          and(
            eq(adsConversionOutbox.siteId, siteId),
            eq(adsConversionOutbox.status, "pending"),
            sql`${adsConversionOutbox.nextAttemptAt} <= (now() AT TIME ZONE 'UTC')`
          )
        ),
      // Le bilan du dernier passage du balayage. L'ABSENCE de ligne est une
      // information à part entière : le balayage n'a jamais tourné.
      db.select().from(adsScanState).where(eq(adsScanState.siteId, siteId)).limit(1),
  ]);

  const b = dernierBalayage[0];
  const lastScan: DernierBalayage | null = b
    ? {
        at: b.lastRunAt,
        examined: b.eventsExamined,
        recorded: b.recorded,
        alreadyKnown: b.alreadyKnown,
        duplicates: b.duplicates,
        skippedNoConsent: b.skippedNoConsent,
        skippedNoClick: b.skippedNoClick,
        errors: b.errors,
        truncated: b.truncated,
        unmappedEvents: b.unmappedEvents,
        unmappedTopNames: b.unmappedTopNames
          ? b.unmappedTopNames.split(",").map(n => n.trim()).filter(Boolean)
          : [],
      }
    : null;

  const compte = (etat: string) => parEtat.find(l => l.status === etat)?.n ?? 0;

  return {
    configured: reglages !== null,
    enabled: reglages?.enabled ?? false,
    testMode: reglages?.testMode ?? false,
    customerId: reglages?.customerId ?? null,
    mappings: correspondances[0]?.n ?? 0,
    pending: compte("pending"),
    sent: compte("sent"),
    failed: compte("failed"),
    skipped: compte("skipped"),
    zeroValueSent: envoyeesSansValeur[0]?.n ?? 0,
    lastError: dernierEchec[0]?.lastError
      ? { message: dernierEchec[0].lastError, at: dernierEchec[0].updatedAt }
      : null,
    lastSentAt: dernierEnvoi[0]?.sentAt ?? null,
    oldestPendingAt: plusVieuxEnAttente[0]?.createdAt ?? null,
    oldestOverdueBy: retardEcheance[0]?.retard ?? null,
    lastScan,
    scanVerdict: classerBalayage(lastScan, correspondances[0]?.n ?? 0),
  };
}
