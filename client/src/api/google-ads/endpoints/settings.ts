import { authedFetch } from "../../utils";

/**
 * Réglages Google Ads d'un site, tels que le serveur les rend
 * (`server/src/api/ads/settings.ts` → `ReglagesAds`).
 */
export type AdsSettings = {
  siteId: number;
  customerId: string;
  enabled: boolean;
  testMode: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Un site jamais configuré n'est pas une erreur : c'est l'état initial de tous
 * les sites. Le serveur rend donc `configured: false` avec `settings: null`
 * plutôt qu'un 404, et l'appelant n'a aucun cas d'erreur à traiter pour ça.
 */
export type AdsSettingsResponse = {
  configured: boolean;
  settings: AdsSettings | null;
};

/**
 * Corps du PUT. Chaque champ est optionnel et un champ absent est CONSERVÉ côté
 * serveur : envoyer `{ enabled: true }` ne réinitialise ni le compte ni le mode
 * d'essai. C'est ce qui permet à chaque contrôle de l'écran de n'envoyer que ce
 * qu'il modifie.
 */
export type AdsSettingsInput = {
  customerId?: string;
  enabled?: boolean;
  testMode?: boolean;
};

export type UpdateAdsSettingsResponse = {
  success: boolean;
  settings: AdsSettings;
};

/**
 * GET /api/sites/:siteId/ads/settings
 */
export async function fetchAdsSettings(site: string | number): Promise<AdsSettingsResponse> {
  return authedFetch<AdsSettingsResponse>(`/sites/${site}/ads/settings`);
}

/**
 * PUT /api/sites/:siteId/ads/settings — administrateur du site exigé.
 *
 * 🔴 Le corps passe par `config.data`, PAS par le 2ᵉ argument d'`authedFetch`,
 * qui est la query string. Un corps posé au mauvais endroit part en paramètres
 * d'URL : le serveur reçoit un corps vide, répond 400 « identifiant obligatoire »
 * et rien ne désigne la vraie cause.
 */
export async function updateAdsSettings(
  site: string | number,
  input: AdsSettingsInput
): Promise<UpdateAdsSettingsResponse> {
  return authedFetch<UpdateAdsSettingsResponse>(`/sites/${site}/ads/settings`, undefined, {
    method: "PUT",
    data: input,
  });
}
