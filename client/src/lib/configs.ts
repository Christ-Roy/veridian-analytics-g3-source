import { useQuery } from "@tanstack/react-query";
import { authedFetch } from "../api/utils";

export interface SocialProviderAvailability {
  google: boolean;
  microsoft: boolean;
  github: boolean;
}

interface Configs {
  disableSignup: boolean;
  mapboxToken: string;
  liteDashboard: boolean;
  // Absent des instances antérieures au 2026-08-29 : traiter l'absence comme
  // « aucun provider », jamais comme « tous ».
  socialProviders?: SocialProviderAvailability;
}

export function useConfigs() {
  const { data, isLoading, error } = useQuery<Configs>({
    queryKey: ["configs"],
    queryFn: () => authedFetch<Configs>("/config"),
  });

  return {
    configs: data,
    isLoading,
    error,
  };
}
