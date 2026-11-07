import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "../../../lib/store";
import { createAdsMapping, type AdsMappingInput } from "../endpoints";
import { clesAds } from "./cles";

/**
 * Crée une correspondance. L'état de santé est invalidé aussi : il compte les
 * correspondances, et c'est ce compteur qui explique « configuré mais rien ne
 * part ».
 */
export function useCreateAdsMapping() {
  const queryClient = useQueryClient();
  const { site } = useStore();

  return useMutation({
    mutationFn: (input: AdsMappingInput) => createAdsMapping(site, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clesAds.correspondancesToutes() });
      queryClient.invalidateQueries({ queryKey: clesAds.santeTous() });
    },
  });
}
