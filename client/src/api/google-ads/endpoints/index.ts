// Réglages
export { fetchAdsSettings, updateAdsSettings } from "./settings";
export type {
  AdsSettings,
  AdsSettingsResponse,
  AdsSettingsInput,
  UpdateAdsSettingsResponse,
} from "./settings";

// Correspondances événement → action de conversion
export { fetchAdsMappings, createAdsMapping, deleteAdsMapping } from "./mappings";
export type {
  AdsMapping,
  AdsMappingsResponse,
  AdsMappingInput,
  CreateAdsMappingResponse,
  DeleteAdsMappingResponse,
} from "./mappings";

// État de santé de l'envoi
export { fetchAdsHealth } from "./health";
export type { AdsHealth } from "./health";

export * from "./couts";
