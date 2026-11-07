import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "../../../lib/store";
import { updateAdsSettings, type AdsSettingsInput } from "../endpoints";
import { clesAds } from "./cles";

/**
 * Enregistre les réglages Google Ads du site courant.
 *
 * L'état de santé est invalidé en même temps que les réglages : il PORTE
 * `enabled` et `testMode`. Sans cette seconde invalidation, activer l'envoi
 * laisserait le bandeau de santé annoncer « désactivé » — un écran qui se
 * contredit lui-même sur le seul point qui engage de l'argent.
 */
export function useUpdateAdsSettings() {
  const queryClient = useQueryClient();
  const { site } = useStore();

  return useMutation({
    mutationFn: (input: AdsSettingsInput) => updateAdsSettings(site, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clesAds.reglagesTous() });
      queryClient.invalidateQueries({ queryKey: clesAds.santeTous() });
    },
  });
}
