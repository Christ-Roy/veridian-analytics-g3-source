/**
 * Les clés de cache du module Ads, en un seul endroit.
 *
 * Pourquoi ce fichier plutôt que des tableaux écrits à la main dans chaque
 * hook : l'invalidation se fait par PRÉFIXE (`["ads-settings"]` invalide
 * `["ads-settings", site]`), donc une clé recopiée avec une faute de frappe
 * dans un seul hook ne casse rien de visible — la mutation réussit, l'écran
 * garde l'ancienne valeur, et le défaut se lit comme « l'API n'a pas
 * enregistré ». Une source unique supprime la classe entière.
 */
export const clesAds = {
  reglages: (site?: string | number) => ["ads-settings", site] as const,
  reglagesTous: () => ["ads-settings"] as const,
  correspondances: (site?: string | number) => ["ads-mappings", site] as const,
  correspondancesToutes: () => ["ads-mappings"] as const,
  sante: (site?: string | number) => ["ads-health", site] as const,
  // Les bornes font partie de la clé : sans elles, changer de période rendrait
  // le cache de la période précédente, donc un total qui ne correspond pas aux
  // dates affichées. Un chiffre faux sous le bon libellé.
  couts: (site?: string | number, debut?: string, fin?: string) => ["ads-couts", site, debut, fin] as const,
  santeTous: () => ["ads-health"] as const,
  coutsTous: () => ["ads-couts"] as const,
};
