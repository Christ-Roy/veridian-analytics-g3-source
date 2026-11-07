/**
 * Routes HTTP des réglages Google Ads d'un site.
 *
 * Le module est calqué sur `api/gsc/` : des handlers exportés un par un, une
 * garde d'autorisation explicite DANS chaque handler en plus de la chaîne de
 * `preHandler`, et aucun montage de Fastify dans les tests.
 *
 * 🔴 Pourquoi la garde est écrite deux fois. La chaîne de `preHandler` vit dans
 * `server/src/index.ts` : elle protège la ROUTE. Le contrôle dans le handler
 * protège la FONCTION. Les deux ne se recouvrent pas — un handler recâblé sur
 * une autre chaîne, monté dans un test, appelé depuis un futur MCP, perdrait la
 * première sans que rien ne le signale. Le coût est une requête déjà mise en
 * cache (`sitesAccessCache`), le gain est qu'une seule des deux gardes suffit.
 *
 * 🔴 Niveau d'autorisation : ADMINISTRATEUR DU SITE en écriture, et pas
 * seulement « membre ». Modifier ces réglages engage de l'argent publicitaire
 * (activer l'envoi vers un compte Ads), et le compte visé est celui d'un client.
 * Détourner les conversions d'un site vers un autre compte Ads serait invisible
 * dans l'interface d'analytics et se paierait en enchères faussées.
 *
 * En LECTURE, le niveau est « accès au site », pas « accès public ». La
 * différence compte : `publicSiteScoped` laisse passer un visiteur anonyme sur
 * un site marqué public — c'est le bon choix pour `gsc/status`, ça ne l'est pas
 * ici, où la réponse nomme le compte Google Ads du client.
 *
 * Aucune réponse de ce fichier ne porte de secret : le module de réglages n'en
 * connaît aucun (les identifiants OAuth du compte administrateur vivent dans la
 * configuration serveur, décision n°1 de la conception du 2026-08-29).
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserHasAccessToSite, getUserHasAdminAccessToSite } from "../../lib/auth-utils.js";
import { detailDepense, totalDepense } from "./couts.js";
import { lireTraficPaye } from "./trafic-paye.js";
import {
  creerCorrespondance,
  enregistrerReglages,
  etatSante,
  lireReglages,
  listerCorrespondances,
  supprimerCorrespondance,
} from "./settings.js";

interface ParamsSite {
  Params: { siteId: string };
}

/**
 * Résout le site et la garde d'accès en une fois. Rendre `null` signifie « la
 * réponse est déjà partie » : le handler n'a plus qu'à sortir.
 *
 * Le message de refus est le même pour un site inexistant et pour un site
 * interdit — sinon la différence entre 403 et 404 permettrait d'énumérer les
 * sites de la plateforme.
 */
async function resoudreSite(
  req: FastifyRequest<ParamsSite>,
  res: FastifyReply,
  niveau: "lecture" | "administration"
): Promise<number | null> {
  const siteId = Number(req.params.siteId);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    await res.status(400).send({ error: "Identifiant de site invalide." });
    return null;
  }

  const autorise =
    niveau === "administration"
      ? await getUserHasAdminAccessToSite(req, siteId)
      : await getUserHasAccessToSite(req, siteId);

  if (!autorise) {
    await res.status(403).send({ error: "Accès refusé à ce site." });
    return null;
  }

  return siteId;
}

/** GET /sites/:siteId/ads/settings */
export async function getAdsSettings(req: FastifyRequest<ParamsSite>, res: FastifyReply) {
  try {
    const siteId = await resoudreSite(req, res, "lecture");
    if (siteId === null) return;

    const reglages = await lireReglages(siteId);

    // Un site jamais configuré n'est pas une erreur : c'est l'état initial de
    // tous les sites. Rendre 404 obligerait chaque appelant à traiter un cas
    // d'erreur pour une situation normale.
    return res.send({ configured: reglages !== null, settings: reglages });
  } catch (error) {
    req.log.error(error, "Erreur à la lecture des réglages Ads");
    return res.status(500).send({ error: "Impossible de lire les réglages Ads." });
  }
}

/** PUT /sites/:siteId/ads/settings */
export async function updateAdsSettings(
  req: FastifyRequest<ParamsSite & { Body: { customerId?: unknown; enabled?: unknown; testMode?: unknown } }>,
  res: FastifyReply
) {
  try {
    const siteId = await resoudreSite(req, res, "administration");
    if (siteId === null) return;

    const corps = (req.body ?? {}) as Record<string, unknown>;
    const resultat = await enregistrerReglages(siteId, corps);
    if (!resultat.ok) {
      return res.status(400).send({ error: resultat.message });
    }

    return res.send({ success: true, settings: resultat.reglages });
  } catch (error) {
    req.log.error(error, "Erreur à l'enregistrement des réglages Ads");
    return res.status(500).send({ error: "Impossible d'enregistrer les réglages Ads." });
  }
}

/** GET /sites/:siteId/ads/mappings */
export async function listAdsMappings(req: FastifyRequest<ParamsSite>, res: FastifyReply) {
  try {
    const siteId = await resoudreSite(req, res, "lecture");
    if (siteId === null) return;

    return res.send({ mappings: await listerCorrespondances(siteId) });
  } catch (error) {
    req.log.error(error, "Erreur à la lecture des correspondances Ads");
    return res.status(500).send({ error: "Impossible de lire les correspondances Ads." });
  }
}

/** POST /sites/:siteId/ads/mappings */
export async function createAdsMapping(
  req: FastifyRequest<ParamsSite & { Body: Record<string, unknown> }>,
  res: FastifyReply
) {
  try {
    const siteId = await resoudreSite(req, res, "administration");
    if (siteId === null) return;

    const resultat = await creerCorrespondance(siteId, (req.body ?? {}) as Record<string, unknown>);
    if (!resultat.ok) {
      // 409 pour un doublon, 400 pour une saisie invalide : un appelant doit
      // pouvoir distinguer « corrige ta saisie » de « c'est déjà réglé ».
      return res.status(resultat.conflit ? 409 : 400).send({ error: resultat.message });
    }

    return res.status(201).send({ success: true, mapping: resultat.correspondance });
  } catch (error) {
    req.log.error(error, "Erreur à la création d'une correspondance Ads");
    return res.status(500).send({ error: "Impossible de créer la correspondance Ads." });
  }
}

/** DELETE /sites/:siteId/ads/mappings/:mappingId */
export async function deleteAdsMapping(
  req: FastifyRequest<{ Params: { siteId: string; mappingId: string } }>,
  res: FastifyReply
) {
  try {
    const siteId = await resoudreSite(req as FastifyRequest<ParamsSite>, res, "administration");
    if (siteId === null) return;

    const mappingId = Number(req.params.mappingId);
    if (!Number.isInteger(mappingId) || mappingId <= 0) {
      return res.status(400).send({ error: "Identifiant de correspondance invalide." });
    }

    // La suppression est bornée au site (cf. supprimerCorrespondance) : un
    // identifiant appartenant à un autre site rend 404, jamais une suppression.
    const supprimee = await supprimerCorrespondance(siteId, mappingId);
    if (!supprimee) {
      return res.status(404).send({ error: "Correspondance introuvable pour ce site." });
    }

    return res.send({ success: true });
  } catch (error) {
    req.log.error(error, "Erreur à la suppression d'une correspondance Ads");
    return res.status(500).send({ error: "Impossible de supprimer la correspondance Ads." });
  }
}

/** GET /sites/:siteId/ads/health */
export async function getAdsHealth(req: FastifyRequest<ParamsSite>, res: FastifyReply) {
  try {
    const siteId = await resoudreSite(req, res, "lecture");
    if (siteId === null) return;

    return res.send(await etatSante(siteId));
  } catch (error) {
    req.log.error(error, "Erreur à la lecture de l'état de santé Ads");
    return res.status(500).send({ error: "Impossible de lire l'état de santé Ads." });
  }
}

/**
 * Validation des bornes de dates. Fonction PURE, exportée pour être testée.
 *
 * 🔴 ELLE REFUSE PLUTÔT QUE DE CORRIGER. Une plage inversée ou une date
 * illisible corrigée en silence rendrait un total sur une période que
 * l'utilisateur n'a pas demandée — un chiffre juste pour la mauvaise question,
 * ce qui est pire qu'une erreur. Le format est celui que Postgres attend pour
 * une colonne `date`, et c'est aussi celui de l'API Google : une seule forme à
 * connaître dans toute la chaîne.
 */
export function validerPeriode(
  debut: unknown,
  fin: unknown
): { ok: true; debut: string; fin: string } | { ok: false; message: string } {
  const motif = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof debut !== "string" || !motif.test(debut) || typeof fin !== "string" || !motif.test(fin)) {
    return { ok: false, message: "Les bornes start_date et end_date sont obligatoires, au format AAAA-MM-JJ." };
  }
  if (debut > fin) {
    return { ok: false, message: "start_date est postérieure à end_date." };
  }
  // Une plage démesurée n'est pas une erreur de l'utilisateur, c'est une
  // requête qui balaie la table entière. On la borne plutôt que de la servir.
  const jours = (Date.parse(fin) - Date.parse(debut)) / 86_400_000;
  if (!Number.isFinite(jours)) return { ok: false, message: "Bornes de dates illisibles." };
  if (jours > 400) return { ok: false, message: "La période demandée dépasse 400 jours." };
  return { ok: true, debut, fin };
}

/**
 * GET /sites/:siteId/ads/couts?start_date=&end_date=
 *
 * Répond à la première des cinq questions du ticket d'origine : combien a-t-on
 * dépensé, sur cette période, pour ce site.
 *
 * ⚠️ `totaux` EST UN TABLEAU, UN PAR DEVISE, et jamais un nombre. Un compte
 * Google Ads a sa devise, un client peut en changer, et additionner des euros
 * et des dollars donnerait un chiffre parfaitement plausible et parfaitement
 * faux. La forme de la réponse interdit à l'écran de le faire par accident.
 */
export async function getAdsCouts(
  req: FastifyRequest<ParamsSite & { Querystring: { start_date?: unknown; end_date?: unknown } }>,
  res: FastifyReply
) {
  try {
    const siteId = await resoudreSite(req, res, "lecture");
    if (siteId === null) return;

    const periode = validerPeriode(req.query?.start_date, req.query?.end_date);
    if (!periode.ok) return res.status(400).send({ error: periode.message });

    // Les trois lectures partent ENSEMBLE et sous la même période. Deux points
    // d'entrée séparés laisseraient l'écran demander des bornes différentes
    // pour la dépense et pour le trafic qu'elle a acheté, et afficher côte à
    // côte deux chiffres qui ne parlent pas de la même chose.
    const [totaux, campagnes, trafic] = await Promise.all([
      totalDepense(siteId, periode.debut, periode.fin),
      detailDepense(siteId, periode.debut, periode.fin),
      // Une panne ClickHouse ne doit pas emporter la dépense, qui vient de
      // Postgres : le trafic manquant se rend `null`, et l'écran le dit.
      lireTraficPaye(siteId, periode.debut, periode.fin).catch(erreur => {
        req.log.error(erreur, "Trafic payant illisible, la dépense reste servie");
        return null;
      }),
    ]);

    return res.send({ debut: periode.debut, fin: periode.fin, totaux, campagnes, trafic });
  } catch (error) {
    req.log.error(error, "Erreur à la lecture des dépenses Ads");
    return res.status(500).send({ error: "Impossible de lire les dépenses Google Ads." });
  }
}

/**
 * Les deux chaînes de `preHandler` que les routes attendent. Elles sont
 * fabriquées dans `server/src/index.ts`, seul endroit où `resolveSiteId` et les
 * gardes vivent — ce fichier les reçoit plutôt que de les importer, pour rester
 * enregistrable sous d'autres chaînes (tests, futur MCP) sans les dupliquer.
 */
export interface ChainesAds {
  /** authSiteScoped("ads", "read") : accès au site exigé, pas d'accès public. */
  lecture: { preHandler: unknown };
  /** adminSiteScoped("ads", "write") : administrateur du site exigé. */
  ecriture: { preHandler: unknown };
}

/**
 * Plugin Fastify. `resolveSiteId` doit être PREMIER dans chaque chaîne (il
 * réécrit `params.siteId` du slug vers l'identifiant numérique) ; c'est déjà le
 * cas des fabriques `authSiteScoped` / `adminSiteScoped`.
 */
export function creerRoutesAds(chaines: ChainesAds) {
  return async function adsRoutes(fastify: FastifyInstance) {
    fastify.get("/sites/:siteId/ads/settings", chaines.lecture as any, getAdsSettings);
    fastify.put("/sites/:siteId/ads/settings", chaines.ecriture as any, updateAdsSettings);
    fastify.get("/sites/:siteId/ads/mappings", chaines.lecture as any, listAdsMappings);
    fastify.post("/sites/:siteId/ads/mappings", chaines.ecriture as any, createAdsMapping);
    fastify.delete("/sites/:siteId/ads/mappings/:mappingId", chaines.ecriture as any, deleteAdsMapping);
    fastify.get("/sites/:siteId/ads/health", chaines.lecture as any, getAdsHealth);
    fastify.get("/sites/:siteId/ads/couts", chaines.lecture as any, getAdsCouts);
  };
}
