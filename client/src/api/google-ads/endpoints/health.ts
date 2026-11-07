import { authedFetch } from "../../utils";

/**
 * État de santé de l'envoi des conversions
 * (`server/src/api/ads/settings.ts` → `EtatSanteAds`).
 *
 * Deux compteurs méritent d'être lus pour ce qu'ils sont :
 *
 * - `skipped` : écartées par une règle métier (consentement, fenêtre de 90
 *   jours, mode d'essai). Rien n'est cassé. Sans lui, les autres compteurs ne
 *   totalisent pas la file et on cherche une panne qui n'existe pas.
 * - `zeroValueSent` : conversions ENVOYÉES sans montant. Google les accepte et
 *   les compte, donc aucun compteur d'erreur ne bouge, mais le ROAS du compte
 *   devient faux. C'est le seul défaut du module qu'aucun contrôle d'envoi ne
 *   peut attraper.
 *
 * 🔴 Le témoin d'un drain arrêté est `oldestOverdueBy`, JAMAIS `oldestPendingAt`
 * (voir leurs commentaires ci-dessous). Une file qui grossit ne produit aucune
 * erreur, mais son ancienneté ne la distingue pas d'un réessai qui travaille.
 */
export type AdsHealth = {
  configured: boolean;
  enabled: boolean;
  testMode: boolean;
  customerId: string | null;
  mappings: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
  zeroValueSent: number;
  lastError: { message: string; at: string } | null;
  lastSentAt: string | null;
  oldestPendingAt: string | null;
  /**
   * Retard, EN SECONDES, de la plus vieille conversion dont l'échéance de
   * réessai est dépassée ; `null` quand aucune ne l'est.
   *
   * En secondes calculées par le serveur, et non en date ISO : le navigateur
   * devrait sinon comparer à sa propre horloge, et un poste mal réglé
   * fabriquerait une alerte ou en masquerait une, en silence.
   *
   * À ne pas confondre avec `oldestPendingAt` : l'ancienneté d'une ligne ne dit
   * rien, le report exponentiel du drain monte à 6 h. Une échéance DÉPASSÉE,
   * alors que le drain passe toutes les deux minutes, ne peut vouloir dire
   * qu'une chose : personne ne draine.
   */
  oldestOverdueBy: number | null;
};

/**
 * GET /api/sites/:siteId/ads/health
 */
export async function fetchAdsHealth(site: string | number): Promise<AdsHealth> {
  return authedFetch<AdsHealth>(`/sites/${site}/ads/health`);
}
