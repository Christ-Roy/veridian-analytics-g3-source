import { useQuery } from "@tanstack/react-query";
import { useStore } from "../../../lib/store";
import { fetchAdsHealth } from "../endpoints";
import { clesAds } from "./cles";

/**
 * État de santé de l'envoi des conversions.
 *
 * Rafraîchi seul toutes les 30 secondes tant que l'écran est ouvert : la file
 * bouge sans qu'aucune action de l'utilisateur ne la fasse bouger, et un
 * tableau figé sur des chiffres vieux de dix minutes est précisément ce qui
 * fait conclure « ça ne part pas » à tort.
 */
export function useGetAdsHealth(options?: { site?: number | string; refetchInterval?: number | false }) {
  const { site: storeSite } = useStore();
  const site = options?.site ?? storeSite;

  return useQuery({
    queryKey: clesAds.sante(site),
    queryFn: () => fetchAdsHealth(site!),
    enabled: !!site,
    refetchInterval: options?.refetchInterval ?? 30_000,
  });
}
