import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "../../../lib/store";
import { deleteAdsMapping } from "../endpoints";
import { clesAds } from "./cles";

/** Supprime une correspondance du site courant. */
export function useDeleteAdsMapping() {
  const queryClient = useQueryClient();
  const { site } = useStore();

  return useMutation({
    mutationFn: (mappingId: number) => deleteAdsMapping(site, mappingId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clesAds.correspondancesToutes() });
      queryClient.invalidateQueries({ queryKey: clesAds.santeTous() });
    },
  });
}
