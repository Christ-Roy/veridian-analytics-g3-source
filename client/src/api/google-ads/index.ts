// Point d'entrée du module Google Ads côté client : fonctions ET types, comme
// `api/gsc/endpoints/index.ts`. Les écrans importent d'ici plutôt que de viser
// un fichier de l'implémentation.

export * from "./endpoints";
export * from "./hooks";
export { validerCompteAds, LONGUEUR_COMPTE_MIN, LONGUEUR_COMPTE_MAX } from "./validation";
export type { MotifCompteInvalide, ResultatCompteAds } from "./validation";
