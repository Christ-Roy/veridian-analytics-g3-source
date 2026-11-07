import { authedFetch } from "../../utils";

/**
 * Correspondance « événement métier → action de conversion Google Ads », telle
 * que le serveur la rend (`server/src/api/ads/settings.ts` → `CorrespondanceAds`).
 *
 * `defaultValue` est une CHAÎNE : la colonne est `numeric(14,2)` et un montant
 * ne se promène pas en flottant. `null` signifie « pas de valeur par défaut »,
 * ce qui reste légitime (un formulaire de contact n'a pas de montant) mais
 * alimente le compteur `zeroValueSent` de l'état de santé.
 */
export type AdsMapping = {
  id: number;
  eventName: string;
  conversionActionId: string;
  defaultValue: string | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
};

export type AdsMappingsResponse = {
  mappings: AdsMapping[];
};

export type AdsMappingInput = {
  eventName: string;
  conversionActionId: string;
  /** Montant en chaîne ou nombre ; vide ou absent = pas de valeur par défaut. */
  defaultValue?: string | number | null;
  /** Code ISO 4217 ; absent = EUR côté serveur. */
  currency?: string;
};

export type CreateAdsMappingResponse = {
  success: boolean;
  mapping: AdsMapping;
};

export type DeleteAdsMappingResponse = {
  success: boolean;
};

/**
 * GET /api/sites/:siteId/ads/mappings
 */
export async function fetchAdsMappings(site: string | number): Promise<AdsMappingsResponse> {
  return authedFetch<AdsMappingsResponse>(`/sites/${site}/ads/mappings`);
}

/**
 * POST /api/sites/:siteId/ads/mappings — administrateur du site exigé.
 *
 * Rend 201 en cas de succès, 409 si l'événement est déjà associé à une action.
 * `authedFetch` transforme la réponse d'erreur en `Error` portant le message du
 * serveur : ce message NOMME l'action déjà en place, donc il s'affiche tel quel
 * plutôt que d'être remplacé par un « échec » générique.
 */
export async function createAdsMapping(
  site: string | number,
  input: AdsMappingInput
): Promise<CreateAdsMappingResponse> {
  return authedFetch<CreateAdsMappingResponse>(`/sites/${site}/ads/mappings`, undefined, {
    method: "POST",
    data: input,
  });
}

/**
 * DELETE /api/sites/:siteId/ads/mappings/:mappingId — administrateur du site.
 */
export async function deleteAdsMapping(
  site: string | number,
  mappingId: number
): Promise<DeleteAdsMappingResponse> {
  return authedFetch<DeleteAdsMappingResponse>(`/sites/${site}/ads/mappings/${mappingId}`, undefined, {
    method: "DELETE",
  });
}
