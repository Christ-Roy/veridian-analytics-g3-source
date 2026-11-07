import { useQuery } from "@tanstack/react-query";
import { useStore } from "../../../lib/store";
import { fetchAdsCouts } from "../endpoints";
import { clesAds } from "./cles";

/**
 * Dépenses publicitaires sur une période.
 *
 * Pas de `refetchInterval`, contrairement à l'état de santé : ces chiffres
 * viennent d'un import horaire et ne bougent pas entre deux passages. Les
 * rafraîchir toutes les trente secondes ferait autant de requêtes pour rien.
 */
export function useGetAdsCouts(debut: string, fin: string, options?: { site?: number | string }) {
  const { site: storeSite } = useStore();
  const site = options?.site ?? storeSite;

  return useQuery({
    queryKey: clesAds.couts(site, debut, fin),
    queryFn: () => fetchAdsCouts(site!, debut, fin),
    enabled: !!site && !!debut && !!fin,
  });
}
