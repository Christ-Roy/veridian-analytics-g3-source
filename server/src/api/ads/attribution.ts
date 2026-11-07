/**
 * Retrouver l'identifiant de clic Google d'un utilisateur qui vient de convertir.
 *
 * Le cas réel : quelqu'un clique sur une annonce le lundi (l'URL porte
 * `?gclid=…`), repart, revient le jeudi, crée un compte, achète. Le `gclid` du
 * lundi et l'achat du jeudi n'ont, dans nos données, aucun lien direct : le
 * premier est posé sur un événement anonyme, le second sur un utilisateur
 * identifié. Ce fichier fait le raccord.
 *
 * Il ne fait QUE lire. Rien ne s'intercale dans le chemin d'ingestion, et une
 * absence de clic n'est pas une erreur : c'est le cas majoritaire (tout le
 * trafic non payant).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 Pourquoi on ne s'appuie PAS sur `identified_user_id`
 *
 * Le rattachement rétroactif de `identify()` existe, mais il ne suffit pas :
 *
 *   - il n'a lieu qu'au TOUT PREMIER `identify` d'un appareil
 *     (`services/tracker/identifyService.ts`, branche `existingAlias.length === 0`).
 *     Ensuite l'alias est repointé mais ClickHouse n'est plus retouché : un
 *     événement anonyme arrivé après cette première identification reste
 *     orphelin pour toujours ;
 *   - la mutation ClickHouse est ASYNCHRONE et bornée à 30 jours
 *     (`BACKFILL_DAYS`). Le service contient déjà un second passage 15 s plus
 *     tard, ajouté parce que les événements de la visite en cours n'étaient pas
 *     encore écrits — c'est-à-dire précisément ceux qui portent l'identifiant
 *     de clic.
 *
 * La source fiable est donc la table Postgres `user_aliases`, écrite de façon
 * SYNCHRONE au moment de l'`identify`. On y lit l'ensemble des appareils liés à
 * une personne, puis on interroge ClickHouse sur cet ensemble.
 *
 * ⚠️ L'`anonymous_id` stocké dans `user_aliases` est le HACHÉ (empreinte
 * IP + user-agent), celui qui correspond à `events.user_id` — pas l'UUID du
 * navigateur.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 Pourquoi on lit `url_parameters`, jamais `channel`
 *
 * `getChannel.ts` ne connaît que `gclid` et `gad_source` : un clic `gbraid`
 * (iOS) ou `wbraid` (YouTube app-to-web) sans referrer ni UTM est classé
 * `Direct`. La colonne `channel` est un recensement INCOMPLET du payant.
 *
 * `url_parameters Map(String,String)` porte les trois identifiants, et il est
 * rempli par `getAllUrlParams` — qui met les CLÉS en minuscules mais laisse les
 * VALEURS intactes. C'est décisif : la casse d'un `gclid` est significative pour
 * Google. (`getUTMParams`, lui, écrase la casse des valeurs — d'où le fait qu'on
 * ne passe pas par lui.) Vérifié dans `services/tracker/utils.ts`.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/postgres/postgres.js";
import { userAliases } from "../../db/postgres/schema.js";
import { matchesUser } from "../analytics/utils/effectiveUserId.js";
import { QuerySpec, runAnalyticsQuery } from "../analytics/utils/analyticsQuery.js";
import { normalizeDatetimeForClickhouse } from "../analytics/utils/timeWindow.js";

/**
 * Fenêtre d'attribution, en jours.
 *
 * Ce n'est pas un réglage de confort : Google REFUSE une conversion hors ligne
 * dont le clic a plus de 90 jours (« This click is too old for its conversion to
 * be imported »). Le `gclid` n'est pas conservé au-delà. Remonter un clic plus
 * ancien ne produirait donc pas une erreur visible, mais un envoi accepté en
 * HTTP 200 et jamais compté — le motif « répond OK sans rien faire », qui est
 * exactement ce qu'on cherche à ne pas fabriquer ici.
 *
 * On la borne donc à la source : le clic qui ne servira à rien n'est jamais
 * remonté.
 *
 * Ce qui la rendrait caduque : Google allongeant sa rétention de `gclid`.
 */
export const FENETRE_CLIC_JOURS = 90;

/**
 * Nombre de clics remontés par la requête.
 *
 * On n'en ramène pas un seul, alors qu'un seul sera retenu, pour deux raisons :
 * le choix (dernier clic, priorité entre identifiants) devient une fonction pure
 * testable sans base, et les clics écartés restent disponibles pour le
 * diagnostic — « pourquoi ce gclid-là ? » se répond alors sans rejouer la requête.
 */
export const LIMITE_CLICS = 10;

/**
 * Premier ou dernier clic ?
 *
 * **Retenu par défaut : `dernier`.** Deux raisons, dans cet ordre :
 *
 *  1. c'est ce que Google compte. Une conversion hors ligne est attribuée au
 *     clic qu'on lui désigne, et le modèle d'attribution du compte raisonne sur
 *     le parcours qui a MENÉ à la conversion. Désigner le premier clic, c'est
 *     créditer une campagne que Google, lui, ne créditerait pas ;
 *  2. c'est le seul choix qui reste valide dans le temps. Un premier clic vieux
 *     de 100 jours est hors fenêtre et l'import est refusé, alors qu'un clic
 *     récent existait et aurait été accepté. Le premier clic fait donc perdre
 *     des conversions que le dernier fait remonter.
 *
 * Un client pose le `gclid` en PREMIER clic et ne l'écrase jamais
 * (`~/site-clients/app-exemple/src/lib/ads-attribution.ts`), mais il STOCKE
 * dans le navigateur au moment du clic : ne jamais écraser est alors la seule
 * façon de ne pas perdre l'origine. Ici on LIT l'historique à la demande, donc
 * les deux nous sont accessibles et le compromis ne se pose pas dans les mêmes
 * termes.
 *
 * `premier` reste exposé et testé : c'est ce qu'il faudra si un jour on veut
 * mesurer l'acquisition plutôt que déclarer une conversion.
 */
export type StrategieAttribution = "dernier" | "premier";

/** Les trois identifiants de clic, dans l'ordre de priorité de Google. */
export const TYPES_IDENTIFIANT = ["gclid", "gbraid", "wbraid"] as const;
export type TypeIdentifiantClic = (typeof TYPES_IDENTIFIANT)[number];

/** Une ligne d'événement portant au moins un identifiant de clic. */
export interface LigneClic {
  /**
   * Instant du clic, en RFC 3339 UTC (`2026-08-24T09:00:00Z`).
   *
   * Rendu en UTC par la requête elle-même, jamais en chaîne ClickHouse nue :
   * un `YYYY-MM-DD hh:mm:ss` sans fuseau est une invitation à l'erreur pour
   * l'appelant, qui envoie ensuite un `eventTimestamp` à Google — lequel exige
   * de l'UTC strict.
   *
   * ⚠️ Le format est `%FT%TZ`, pas `%Y-%m-%dT%H:%M:%SZ`. Dans `formatDateTime`,
   * `%M` est le MOIS EN TOUTES LETTRES, pas les minutes (`%i`) : la seconde
   * écriture rend `2026-08-29T10:August:22Z`. Mesuré sur la production le
   * 2026-08-29 — aucune erreur, juste une date fausse.
   */
  horodatage: string;
  gclid: string;
  gbraid: string;
  wbraid: string;
}

export interface IdentifiantClic {
  type: TypeIdentifiantClic;
  /** La valeur telle qu'elle a été reçue, casse comprise. Ne jamais la normaliser. */
  valeur: string;
  horodatage: string;
}

export interface ParametresRequeteClic {
  siteId: number;
  /** Identité retenue : un `user_id` d'`identify()`, ou une empreinte d'appareil. */
  utilisateur: string;
  /** Toutes les empreintes d'appareil liées à cette identité, celle-ci comprise. */
  appareils: string[];
  /** Horodatage métier de la conversion. Aucun clic postérieur ne peut l'avoir causée. */
  conversionAt: Date;
  fenetreJours?: number;
  strategie?: StrategieAttribution;
  limite?: number;
}

/**
 * Prédicat « ces événements appartiennent à cette personne ».
 *
 * Généralisation à un ENSEMBLE d'appareils du prédicat `matchesUser` du dépôt,
 * qu'on réutilise tel quel pour la branche identifiée. Le motif est celui de
 * `deleteUser.ts`, qui parcourt le même graphe d'alias.
 *
 * ⚠️ La branche « appareil » reste gardée par `identified_user_id = ''`, comme
 * dans `matchesUser`. L'empreinte est un haché IP + user-agent : elle collisionne
 * derrière un proxy d'entreprise ou un CGNAT. Sans cette garde, on récupérerait
 * le clic d'un collègue et on l'attribuerait à la commande de son voisin de
 * bureau. Le risque résiduel demeure sur les événements ANONYMES d'une empreinte
 * partagée — c'est le compromis assumé de tout le dépôt, et il n'y a pas mieux à
 * disposition sans identifiant de première partie.
 */
export const appartientAUtilisateur = () =>
  `(${matchesUser("{utilisateur:String}")} OR (user_id IN ({appareils:Array(String)}) AND identified_user_id = ''))`;

/**
 * Construit la requête. Fonction PURE : elle ne touche ni la base ni le réseau,
 * donc un test peut vérifier le SQL et les paramètres sans ClickHouse. C'est le
 * motif du dépôt (`buildUserInfoQueries`).
 *
 * ⚠️ Aucune valeur n'est concaténée dans le SQL : tout passe par les paramètres
 * liés `{nom:Type}`.
 */
export function construireRequeteClic({
  siteId,
  utilisateur,
  appareils,
  conversionAt,
  fenetreJours = FENETRE_CLIC_JOURS,
  strategie = "dernier",
  limite = LIMITE_CLICS,
}: ParametresRequeteClic): QuerySpec {
  const debut = new Date(conversionAt.getTime() - fenetreJours * 24 * 60 * 60 * 1000);

  // Deux précautions de fuseau, mesurées le 2026-08-29 sur la production :
  //
  //  - `toDateTime` refuse un `Z` et un décalage `+02:00` — d'où le passage par
  //    le normaliseur du dépôt, qui rend l'instant en UTC nu. Cf. timeWindow.ts ;
  //  - la colonne est un `DateTime` SANS fuseau : ClickHouse la stocke en epoch
  //    mais parse et rend les chaînes dans le fuseau du SERVEUR. On ancre donc
  //    explicitement les deux bornes ET la projection sur `'UTC'`, au lieu de
  //    dépendre du `TZ=UTC` des jobs Nomad. Aujourd'hui les deux disent la même
  //    chose (`now()` de ClickHouse = heure UTC réelle, dernier événement à
  //    95 s dans le passé et non à deux heures dans le futur) ; l'ancrage fait
  //    que cela restera vrai si un jour un conteneur perd son `TZ`.
  //
  // ⚠️ Ce que l'ancrage ne répare PAS : si le process d'INGESTION cessait de
  // tourner en UTC, `pageviewQueue` écrirait de l'heure locale et toute la
  // colonne serait décalée. Aucune lecture ne peut rattraper ça. Le contrôle
  // qui le verrait est un `dateDiff('second', max(timestamp), now())` négatif.
  const params = {
    siteId,
    utilisateur,
    appareils: appareils.length > 0 ? appareils : [utilisateur],
    debut: normalizeDatetimeForClickhouse(debut.toISOString()),
    fin: normalizeDatetimeForClickhouse(conversionAt.toISOString()),
    limite,
  };

  // Les bornes de temps d'abord : la table est triée par (site_id, timestamp),
  // donc elles élaguent avant tout le reste.
  const query = `
    SELECT
        formatDateTime(timestamp, '%FT%TZ', 'UTC') AS horodatage,
        url_parameters['gclid'] AS gclid,
        url_parameters['gbraid'] AS gbraid,
        url_parameters['wbraid'] AS wbraid
    FROM events
    WHERE
        site_id = {siteId:UInt16}
        AND timestamp >= toDateTime({debut:String}, 'UTC')
        AND timestamp <= toDateTime({fin:String}, 'UTC')
        AND ${appartientAUtilisateur()}
        AND (
            url_parameters['gclid'] != ''
            OR url_parameters['gbraid'] != ''
            OR url_parameters['wbraid'] != ''
        )
    ORDER BY timestamp ${strategie === "dernier" ? "DESC" : "ASC"}
    LIMIT {limite:UInt32}
  `;

  return { query, params };
}

/**
 * Choisit l'identifiant à envoyer. Fonction PURE.
 *
 * Deux arbitrages, tous deux visibles ici plutôt que noyés dans le SQL :
 *
 *  - **entre événements** : le plus récent pour `dernier`, le plus ancien pour
 *    `premier`. Le tri est refait en JavaScript et ne dépend donc pas de l'ordre
 *    rendu par la requête — un `ORDER BY` oublié se verrait dans les tests, pas
 *    en production ;
 *  - **au sein d'un même événement** : `gclid` puis `gbraid` puis `wbraid`.
 *    C'est l'ordre de `pickAdIdentifiers` dans `dataManager.ts`, et celui de
 *    Google : `gbraid` et `wbraid` sont les REMPLAÇANTS du `gclid` quand
 *    celui-ci ne peut pas être posé (iOS, app-to-web). Quand les deux sont
 *    présents, le `gclid` est le plus informatif.
 *
 * À horodatage égal, la ligne qui porte l'identifiant le plus prioritaire
 * l'emporte : deux événements de la même seconde ne doivent pas donner un
 * résultat qui dépend de l'ordre de lecture.
 */
export function choisirIdentifiant(
  lignes: LigneClic[],
  strategie: StrategieAttribution = "dernier",
): IdentifiantClic | null {
  const candidats: IdentifiantClic[] = [];

  for (const ligne of lignes) {
    for (const type of TYPES_IDENTIFIANT) {
      const valeur = ligne[type];
      if (valeur) {
        candidats.push({ type, valeur, horodatage: ligne.horodatage });
        break; // priorité intra-événement : un seul identifiant par ligne
      }
    }
  }

  if (candidats.length === 0) return null;

  const rang = (c: IdentifiantClic) => TYPES_IDENTIFIANT.indexOf(c.type);
  return candidats.reduce((meilleur, courant) => {
    if (courant.horodatage === meilleur.horodatage) {
      return rang(courant) < rang(meilleur) ? courant : meilleur;
    }
    const plusRecent = courant.horodatage > meilleur.horodatage;
    return (strategie === "dernier") === plusRecent ? courant : meilleur;
  });
}

export interface AppareilsLies {
  /** Identité canonique : le `user_id` d'`identify()` s'il existe, sinon l'entrée telle quelle. */
  utilisateur: string;
  /** Toutes les empreintes d'appareil connues pour cette identité, l'entrée comprise. */
  appareils: string[];
}

/**
 * Remonte l'ensemble des appareils d'une personne depuis `user_aliases`.
 *
 * L'appelant peut fournir l'un ou l'autre bout du lien — c'est le cas dans tout
 * le dépôt, où un « userId » d'URL est indifféremment une identité ou une
 * empreinte. Les deux sens sont donc traités :
 *
 *  - identité connue → ses appareils ;
 *  - empreinte connue → on remonte à l'identité, PUIS on redescend sur tous ses
 *    appareils. Sans ce second temps, un achat fait depuis le téléphone ne
 *    verrait jamais le clic reçu sur l'ordinateur, qui est précisément le cas
 *    que ce module existe pour traiter.
 */
export async function resoudreAppareils(siteId: number, identifiant: string): Promise<AppareilsLies> {
  const appareilsDe = (userId: string) =>
    db
      .select({ anonymousId: userAliases.anonymousId })
      .from(userAliases)
      .where(and(eq(userAliases.siteId, siteId), eq(userAliases.userId, userId)));

  let utilisateur = identifiant;
  let lignes = await appareilsDe(identifiant);

  if (lignes.length === 0) {
    const alias = await db
      .select({ userId: userAliases.userId })
      .from(userAliases)
      .where(and(eq(userAliases.siteId, siteId), eq(userAliases.anonymousId, identifiant)))
      .limit(1);

    if (alias.length > 0) {
      utilisateur = alias[0].userId;
      lignes = await appareilsDe(utilisateur);
    }
  }

  const appareils = new Set<string>([identifiant, ...lignes.map(l => l.anonymousId)]);
  return { utilisateur, appareils: [...appareils] };
}

export interface DemandeAttribution {
  siteId: number;
  /** Identité ou empreinte d'appareil de la personne qui a converti. */
  utilisateur: string;
  /** Horodatage métier de la conversion. */
  conversionAt: Date;
  fenetreJours?: number;
  strategie?: StrategieAttribution;
}

export interface ResultatAttribution {
  /** `null` quand la personne n'a jamais cliqué sur une annonce dans la fenêtre. */
  identifiant: IdentifiantClic | null;
  /** Identité canonique retenue, pour le diagnostic. */
  utilisateur: string;
  /** Appareils interrogés, pour le diagnostic. */
  appareils: string[];
  /** Tous les clics de la fenêtre, le retenu compris, du plus pertinent au moins. */
  clics: LigneClic[];
}

/**
 * Retrouve l'identifiant de clic à joindre à une conversion.
 *
 * L'absence de clic rend un résultat VIDE, jamais une erreur : le trafic non
 * payant est la majorité, et c'est à l'appelant de décider qu'il n'y a rien à
 * envoyer. Une panne de base, elle, remonte — l'outbox doit pouvoir réessayer,
 * et un « pas de clic » silencieux sur une base indisponible ferait perdre des
 * conversions sans laisser de trace.
 */
export async function retrouverIdentifiantClic({
  siteId,
  utilisateur,
  conversionAt,
  fenetreJours = FENETRE_CLIC_JOURS,
  strategie = "dernier",
}: DemandeAttribution): Promise<ResultatAttribution> {
  const lies = await resoudreAppareils(siteId, utilisateur);

  const spec = construireRequeteClic({
    siteId,
    utilisateur: lies.utilisateur,
    appareils: lies.appareils,
    conversionAt,
    fenetreJours,
    strategie,
  });

  const clics = await runAnalyticsQuery<LigneClic>(spec);

  return {
    identifiant: choisirIdentifiant(clics, strategie),
    utilisateur: lies.utilisateur,
    appareils: lies.appareils,
    clics,
  };
}
