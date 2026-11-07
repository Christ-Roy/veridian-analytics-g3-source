import { useQuery } from "@tanstack/react-query";
import { useStore } from "../../../lib/store";
import { fetchAdsSettings } from "../endpoints";
import { clesAds } from "./cles";

/**
 * Lit les réglages Google Ads du site courant. Le site vient du store posé par
 * le layout, jamais d'une prop : deux sources pour un même identifiant, c'est
 * la garantie qu'un écran finira par afficher les réglages d'un autre client.
 */
export function useGetAdsSettings(options?: { site?: number | string }) {
  const { site: storeSite } = useStore();
  const site = options?.site ?? storeSite;

  return useQuery({
    queryKey: clesAds.reglages(site),
    queryFn: () => fetchAdsSettings(site!),
    enabled: !!site,
  });
}
