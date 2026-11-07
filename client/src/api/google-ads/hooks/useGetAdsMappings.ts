import { useQuery } from "@tanstack/react-query";
import { useStore } from "../../../lib/store";
import { fetchAdsMappings } from "../endpoints";
import { clesAds } from "./cles";

/** Liste les correspondances « événement → action de conversion » du site courant. */
export function useGetAdsMappings(options?: { site?: number | string }) {
  const { site: storeSite } = useStore();
  const site = options?.site ?? storeSite;

  return useQuery({
    queryKey: clesAds.correspondances(site),
    queryFn: () => fetchAdsMappings(site!),
    enabled: !!site,
  });
}
