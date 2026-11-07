/**
 * La couche qui va chercher les chiffres du diagnostic dans ClickHouse.
 *
 * Séparée de `mesure.ts` à dessein : le verdict est une fonction pure, testable
 * sans base ; ici on ne fait que remplir ses entrées. C'est le motif du dépôt
 * (`buildUserInfoQueries` / `runAnalyticsQuery`, `construireRequeteEvenements`
 * dans `ads/balayage.ts`).
 *
 * ⚠️ Aucune valeur n'est concaténée dans le SQL : tout passe par des paramètres
 * liés, y compris les listes de clés.
 *
 * ⚠️ Les bornes de temps sont ancrées sur `'UTC'` aux deux extrémités, parce que
 * `timestamp` est un `DateTime` SANS fuseau que ClickHouse rend dans le fuseau du
 * SERVEUR. Sans l'ancrage, un serveur en `Europe/Paris` décale la fenêtre de deux
 * heures et le diagnostic conclut sur une période qui n'est pas celle demandée.
 *
 * 🔴 Les listes de clés (valeur monétaire, identifiant métier, consentement) sont
 * IMPORTÉES de `ads/balayage.ts` et jamais recopiées. Le diagnostic doit dire ce
 * que le module d'envoi VERRA. Deux listes qui divergent produiraient le pire des
 * résultats possibles : un diagnostic vert sur un site dont rien ne part.
 */
import {
  CLES_CONSENT_AD_USER_DATA,
  CLES_IDENTIFIANT_METIER,
  CLES_VALEUR,
} from "../ads/balayage.js";
import { lireReglages, listerCorrespondances } from "../ads/settings.js";
import { QuerySpec, runAnalyticsQuery } from "../analytics/utils/analyticsQuery.js";
import { normalizeDatetimeForClickhouse } from "../analytics/utils/timeWindow.js";
import type { EntreesDiagnostic, StatistiquesEvenement } from "./mesure.js";

/** Limite d'octets des propriétés à l'ingestion (`trackingPayload.ts`). */
export const LIMITE_PROPS_OCTETS = 2048;

/**
 * Seuil au-delà duquel on considère que les propriétés « frôlent » la limite.
 *
 * 88 % de la limite : assez haut pour ne pas se déclencher sur des propriétés
 * ordinaires, assez bas pour attraper un site dont la charge utile grossit avec
 * le panier — celui-là passe la limite un jour, sur les gros paniers seulement,
 * c'est-à-dire sur ses meilleures conversions.
 *
 * ⚠️ CHOISI, pas mesuré, comme tous les seuils de `mesure.ts` (voir la note en
 * tête de leur section). La limite de 2048, elle, ne l'est pas : c'est celle de
 * la validation à l'ingestion.
 */
export const SEUIL_PROPS_PRESQUE_LONGUES = 1800;

/** Nombre maximal de noms d'événements distincts détaillés. Au-delà, le site a un autre problème. */
export const LIMITE_NOMS_DETAILLES = 200;

/** Les clés de valeur, aplaties : le SQL n'a besoin que des noms. */
const NOMS_CLES_VALEUR = CLES_VALEUR.map(([cle]) => cle);

export interface FenetreDiagnostic {
  debut: Date;
  fin: Date;
  jours: number;
}

/**
 * Construit la fenêtre observée. `jours` est borné : une fenêtre trop courte ne
 * permet aucune conclusion (et le diagnostic le dirait mal), une fenêtre trop
 * longue fait travailler ClickHouse sur plusieurs partitions pour rien.
 */
export function construireFenetre(jours: unknown, maintenant = new Date()): FenetreDiagnostic {
  // ⚠️ Le test d'absence passe AVANT la conversion, et ce n'est pas une
  // précaution de style : `Number("")` et `Number(null)` valent **0**, un nombre
  // fini, que le bornage remonterait à 1. Un `?days=` vide — le cas le plus banal
  // d'un appel construit par une interface — rendrait alors une fenêtre d'UN
  // jour, et le diagnostic conclurait « volume insuffisant » sur un site
  // parfaitement mesuré, sans que rien ne signale que la période n'était pas
  // celle demandée.
  const absent = jours === undefined || jours === null || jours === "";
  const brut = absent ? NaN : Number(jours);
  const retenu = Number.isFinite(brut) ? Math.min(90, Math.max(1, Math.trunc(brut))) : 30;
  return {
    debut: new Date(maintenant.getTime() - retenu * 24 * 60 * 60 * 1000),
    fin: maintenant,
    jours: retenu,
  };
}

/* ───────────────────────────── Les trois requêtes ───────────────────────── */

/**
 * Agrégat par nom d'événement, avec la qualité des propriétés.
 *
 * ⚠️ `event_name != ''` écarte les pages vues, qui n'ont pas de nom. Sans ce
 * filtre l'agrégat remonterait tout le trafic sous un nom vide et le diagnostic
 * conclurait que le site émet un événement métier par page vue.
 *
 * ⚠️ La valeur est lue par `toFloat64OrNull(trim(BOTH '"' FROM …))` et non par
 * `JSONExtractFloat`, qui rend **0** sur une chaîne illisible. Ce zéro se
 * confondrait avec un montant nul et interdirait de distinguer « pas de montant »
 * de « montant écrit `"49,90 €"` » — précisément le constat qu'on veut rendre.
 */
export function construireRequeteEvenements(params: {
  siteId: number;
  debut: Date;
  fin: Date;
  seuilProps?: number;
  limite?: number;
}): QuerySpec {
  const query = `
    SELECT
        nom,
        count() AS total,
        uniqExact(sessionId) AS sessions,
        countIf(valeur IS NOT NULL) AS avecValeur,
        countIf(cleValeur != '' AND valeur IS NULL) AS valeurNonNumerique,
        countIf(cleIdentifiant != '') AS avecIdentifiant,
        countIf(cleConsentement != '') AS avecConsentement,
        min(valeur) AS valeurMin,
        max(valeur) AS valeurMax,
        quantileExact(0.5)(valeur) AS valeurMediane,
        countIf(tailleProps >= {seuilProps:UInt32}) AS propsPresqueLongues,
        max(tailleProps) AS propsTailleMax
    FROM (
        SELECT
            event_name AS nom,
            session_id AS sessionId,
            length(toString(props)) AS tailleProps,
            arrayFirst(k -> JSONHas(toString(props), k), {clesValeur:Array(String)}) AS cleValeur,
            arrayFirst(k -> JSONHas(toString(props), k), {clesIdentifiant:Array(String)}) AS cleIdentifiant,
            arrayFirst(k -> JSONHas(toString(props), k), {clesConsentement:Array(String)}) AS cleConsentement,
            toFloat64OrNull(trim(BOTH '"' FROM JSONExtractRaw(toString(props), cleValeur))) AS valeur
        FROM events
        WHERE
            site_id = {siteId:UInt16}
            AND timestamp >= toDateTime({debut:String}, 'UTC')
            AND timestamp <= toDateTime({fin:String}, 'UTC')
            AND event_name != ''
    )
    GROUP BY nom
    ORDER BY total DESC
    LIMIT {limite:UInt32}
  `;

  return {
    query,
    params: {
      siteId: params.siteId,
      debut: normalizeDatetimeForClickhouse(params.debut.toISOString()),
      fin: normalizeDatetimeForClickhouse(params.fin.toISOString()),
      clesValeur: NOMS_CLES_VALEUR,
      clesIdentifiant: [...CLES_IDENTIFIANT_METIER],
      clesConsentement: [...CLES_CONSENT_AD_USER_DATA],
      seuilProps: params.seuilProps ?? SEUIL_PROPS_PRESQUE_LONGUES,
      limite: params.limite ?? LIMITE_NOMS_DETAILLES,
    },
  };
}

/**
 * Les totaux du site sur la période : pages vues, trafic de centre de données,
 * et le nombre de noms distincts.
 *
 * ⚠️ `nomsDistincts` est compté ICI et non sur l'agrégat détaillé, qui est borné
 * par `LIMITE_NOMS_DETAILLES`. Le déduire du détail plafonnerait le compteur
 * juste sous la limite qu'il sert à surveiller — un contrôle qui ne peut jamais
 * se déclencher.
 */
export function construireRequeteTotaux(params: { siteId: number; debut: Date; fin: Date }): QuerySpec {
  const query = `
    SELECT
        countIf(type = 'pageview') AS pagesVues,
        count() AS lignes,
        countIf(is_datacenter_asn = 1) AS traficDatacenter,
        uniqExactIf(event_name, event_name != '') AS nomsDistincts
    FROM events
    WHERE
        site_id = {siteId:UInt16}
        AND timestamp >= toDateTime({debut:String}, 'UTC')
        AND timestamp <= toDateTime({fin:String}, 'UTC')
  `;

  return {
    query,
    params: {
      siteId: params.siteId,
      debut: normalizeDatetimeForClickhouse(params.debut.toISOString()),
      fin: normalizeDatetimeForClickhouse(params.fin.toISOString()),
    },
  };
}

/** Le trafic écarté comme robot, dans sa table dédiée. */
export function construireRequeteRobots(params: { siteId: number; debut: Date; fin: Date }): QuerySpec {
  const query = `
    SELECT count() AS robots
    FROM bot_events
    WHERE
        site_id = {siteId:UInt16}
        AND timestamp >= toDateTime({debut:String}, 'UTC')
        AND timestamp <= toDateTime({fin:String}, 'UTC')
  `;

  return {
    query,
    params: {
      siteId: params.siteId,
      debut: normalizeDatetimeForClickhouse(params.debut.toISOString()),
      fin: normalizeDatetimeForClickhouse(params.fin.toISOString()),
    },
  };
}

/* ────────────────────────────── La collecte ─────────────────────────────── */

interface LigneEvenement {
  nom: string;
  total: number | string;
  sessions: number | string;
  avecValeur: number | string;
  valeurNonNumerique: number | string;
  avecIdentifiant: number | string;
  avecConsentement: number | string;
  valeurMin: number | string | null;
  valeurMax: number | string | null;
  valeurMediane: number | string | null;
  propsPresqueLongues: number | string;
  propsTailleMax: number | string;
}

/** ClickHouse rend les entiers 64 bits en chaîne. Tout passe par ici, une fois. */
function nombre(valeur: unknown): number {
  const n = Number(valeur);
  return Number.isFinite(n) ? n : 0;
}

/** Idem, mais `null` reste `null` : c'est « aucune valeur lue », pas « zéro ». */
function nombreOuNul(valeur: unknown): number | null {
  if (valeur === null || valeur === undefined || valeur === "") return null;
  const n = Number(valeur);
  return Number.isFinite(n) ? n : null;
}

/**
 * Remplit les entrées du diagnostic pour un site et une fenêtre.
 *
 * 🔴 La lecture du trafic robot est la SEULE dont l'échec est toléré, et il ne
 * se dégrade pas en zéro : `traficRobot` reste `null`, et `mesure.ts` en fait un
 * constat explicite « je n'ai pas la donnée ». Toute autre erreur remonte —
 * rendre un rapport partiel en le présentant comme complet serait fabriquer
 * exactement le défaut que ce module existe pour attraper.
 */
export async function collecterEntrees(
  siteId: number,
  fenetre: FenetreDiagnostic,
  options: { logger?: { warn: (obj: unknown, msg: string) => void } } = {}
): Promise<EntreesDiagnostic> {
  const bornes = { siteId, debut: fenetre.debut, fin: fenetre.fin };

  const [lignes, totaux, robots, correspondances, reglages] = await Promise.all([
    runAnalyticsQuery<LigneEvenement>(construireRequeteEvenements(bornes)),
    runAnalyticsQuery<{ pagesVues: number | string; lignes: number | string; traficDatacenter: number | string; nomsDistincts: number | string }>(
      construireRequeteTotaux(bornes)
    ),
    runAnalyticsQuery<{ robots: number | string }>(construireRequeteRobots(bornes)).catch(erreur => {
      options.logger?.warn({ erreur, siteId }, "Trafic robot illisible : le diagnostic le signalera comme inconnu");
      return null;
    }),
    listerCorrespondances(siteId),
    lireReglages(siteId),
  ]);

  const evenements: StatistiquesEvenement[] = lignes.map(l => ({
    nom: l.nom,
    total: nombre(l.total),
    sessions: nombre(l.sessions),
    avecValeur: nombre(l.avecValeur),
    valeurNonNumerique: nombre(l.valeurNonNumerique),
    avecIdentifiant: nombre(l.avecIdentifiant),
    avecConsentement: nombre(l.avecConsentement),
    valeurMin: nombreOuNul(l.valeurMin),
    valeurMax: nombreOuNul(l.valeurMax),
    valeurMediane: nombreOuNul(l.valeurMediane),
    propsPresqueLongues: nombre(l.propsPresqueLongues),
    propsTailleMax: nombre(l.propsTailleMax),
  }));

  const t = totaux[0];

  return {
    siteId,
    periode: { debut: fenetre.debut.toISOString(), fin: fenetre.fin.toISOString(), jours: fenetre.jours },
    pagesVues: nombre(t?.pagesVues),
    totalLignes: nombre(t?.lignes),
    evenements,
    nomsDistincts: nombre(t?.nomsDistincts),
    traficDatacenter: nombre(t?.traficDatacenter),
    traficRobot: robots === null ? null : nombre(robots[0]?.robots),
    correspondances: correspondances.map(c => ({
      eventName: c.eventName,
      conversionActionId: c.conversionActionId,
    })),
    // `null` = aucun réglage. Ce n'est pas « désactivé » : un site sans compte
    // publicitaire et un site dont l'envoi est coupé ne se diagnostiquent pas
    // pareil, et le second mérite qu'on regarde ses correspondances.
    adsActif: reglages === null ? null : Boolean(reglages.enabled),
  };
}
