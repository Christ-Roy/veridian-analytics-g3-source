"use client";

// Side-effect import: teaches authedFetch where to find the private key so the
// HTTP layer itself doesn't have to know about routing or the store.
import "@/api/installRequestContext";
import { useStopImpersonation } from "@/hooks/useStopImpersonation";
import { getStoredDashboardDefaultTime } from "@/lib/defaultTimeRange";
import { getTimezone, useStore } from "@/lib/store";
import QueryProvider from "@/providers/QueryProvider";
import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { useEffect } from "react";
import { AuthenticationGuard } from "../components/AuthenticationGuard";
import { OrganizationInitializer } from "../components/OrganizationInitializer";
import { Toaster } from "../components/ui/sonner";
import { VersionCheck } from "../components/VersionCheck";
import { TooltipProvider } from "../components/ui/tooltip";

type EmbedTheme = "light" | "dark" | "system";

function DashboardTimeInitializer() {
  const setTime = useStore(state => state.setTime);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hasTimeInUrl = params.has("timeMode") || params.has("wellKnown");

    if (!hasTimeInUrl) {
      setTime(getStoredDashboardDefaultTime(getTimezone()), !params.has("bucket"));
    }
  }, [setTime]);

  return null;
}

function getEmbedTheme(): EmbedTheme | null {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  if (params.get("embed") !== "true") return null;

  const theme = params.get("theme");
  if (theme === "light" || theme === "dark" || theme === "system") {
    return theme;
  }

  return "system";
}

export function Providers({ children }: { children: React.ReactNode }) {
  useStopImpersonation();
  const embedTheme = getEmbedTheme();
  const themeStorageKey = embedTheme ? `embed-theme-${embedTheme}` : "theme";

  return (
    <NuqsAdapter>
      <ThemeProvider
        key={themeStorageKey}
        attribute="class"
        enableSystem={true}
        defaultTheme={embedTheme ?? "system"}
        storageKey={themeStorageKey}
        disableTransitionOnChange
      >
        <TooltipProvider>
          <QueryProvider>
            <DashboardTimeInitializer />
            <OrganizationInitializer />
            <AuthenticationGuard />
            {children}
            <VersionCheck />
          </QueryProvider>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
      {/*
        Veridian : upstream chargeait ici le script de suivi de l'éditeur amont,
        ce qui envoyait la navigation de NOS clients dans la console chez
        l'éditeur amont. Inacceptable pour un service vendu sans cookie et
        hébergé en France. Retiré. Si un jour on veut mesurer l'usage de la
        console, on la trackera sur notre propre instance.
      */}
      {/*
        Suivait ici le script d'affiliation de l'éditeur amont (Rewardful, avec
        SON identifiant de programme). Il ne se chargeait que sous IS_CLOUD,
        donc jamais chez nous — mais un fork n'a aucune raison de porter la
        monétisation de l'éditeur, et une variable d'environnement inversée par
        erreur suffirait à charger un traceur tiers dans la console de nos
        clients. Retiré plutôt que désactivé.
      */}
    </NuqsAdapter>
  );
}
