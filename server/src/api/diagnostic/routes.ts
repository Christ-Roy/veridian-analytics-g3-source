/**
 * Route de lecture du diagnostic de mesure.
 *
 * Calquée sur `api/ads/routes.ts` : garde d'autorisation écrite DANS le handler
 * en plus de la chaîne de `preHandler`, et aucun montage de Fastify ici.
 *
 * 🔴 Niveau d'autorisation : « accès au site », pas « accès public ». La réponse
 * énumère les noms d'événements du site, leurs volumes et le compte publicitaire
 * qui les consomme — c'est la cartographie du tunnel de vente d'un client. Un
 * site marqué public expose ses statistiques de fréquentation, pas ça.
 *
 * En LECTURE SEULE, et sans écriture possible : ce module ne fait qu'observer.
 * C'est ce qui autorise le niveau « membre » plutôt qu'« administrateur » —
 * contrairement aux réglages Ads, aucun euro n'est engagé par cet appel.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getUserHasAccessToSite } from "../../lib/auth-utils.js";
import { collecterEntrees, construireFenetre } from "./collecte.js";
import { diagnostiquerMesure } from "./mesure.js";

interface RequeteDiagnostic {
  Params: { siteId: string };
  Querystring: { days?: string };
}

/** GET /sites/:siteId/diagnostic/measurement?days=30 */
export async function getMeasurementDiagnostic(req: FastifyRequest<RequeteDiagnostic>, res: FastifyReply) {
  try {
    const siteId = Number(req.params.siteId);
    if (!Number.isInteger(siteId) || siteId <= 0) {
      return res.status(400).send({ error: "Identifiant de site invalide." });
    }

    // Même message pour un site inexistant et pour un site interdit : la
    // différence entre 403 et 404 permettrait d'énumérer les sites.
    if (!(await getUserHasAccessToSite(req, siteId))) {
      return res.status(403).send({ error: "Accès refusé à ce site." });
    }

    // `construireFenetre` borne elle-même (1 à 90 jours) et retombe sur 30 pour
    // toute saisie illisible : la fenêtre est donc toujours valide, et l'appelant
    // sait laquelle a été retenue en lisant `periode` dans la réponse.
    const fenetre = construireFenetre(req.query?.days);
    const entrees = await collecterEntrees(siteId, fenetre, { logger: req.log });

    return res.send(diagnostiquerMesure(entrees));
  } catch (error) {
    req.log.error(error, "Erreur au diagnostic de mesure");
    return res.status(500).send({ error: "Impossible d'établir le diagnostic de mesure." });
  }
}

/**
 * La chaîne de `preHandler` attendue. Fabriquée dans `server/src/index.ts`, seul
 * endroit où `resolveSiteId` et les gardes vivent ; ce fichier la reçoit plutôt
 * que de l'importer, pour rester enregistrable sous d'autres chaînes.
 */
export interface ChainesDiagnostic {
  /** authSiteScoped(…, "read") : accès au site exigé, pas d'accès public. */
  lecture: { preHandler: unknown };
}

/**
 * Plugin Fastify. `resolveSiteId` doit être PREMIER dans la chaîne : il réécrit
 * `params.siteId` du slug vers l'identifiant numérique.
 */
export function creerRoutesDiagnostic(chaines: ChainesDiagnostic) {
  return async function diagnosticRoutes(fastify: FastifyInstance) {
    fastify.get("/sites/:siteId/diagnostic/measurement", chaines.lecture as any, getMeasurementDiagnostic);
  };
}
