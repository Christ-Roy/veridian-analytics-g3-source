"use client";

import { Button } from "@/components/ui/button";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { authClient } from "@/lib/auth";
import { useConfigs } from "@/lib/configs";
import { useExtracted } from "next-intl";
import Image from "next/image";
import type { ReactNode } from "react";

type SocialProviderId = "google" | "microsoft" | "github";

interface SocialButtonsProps {
  onError: (error: string) => void;
  callbackURL?: string;
  mode?: "signin" | "signup";
  className?: string;
}

/**
 * Logo Microsoft officiel (quatre carrés). Inline plutôt qu'en fichier dans
 * public/crawlers/ : ce dossier porte les logos des ROBOTS d'indexation, et un
 * logo de 500 octets ne mérite pas une requête réseau supplémentaire sur la
 * seule page où l'utilisateur n'est pas encore authentifié.
 */
function MicrosoftLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
  );
}

export function SocialButtons({ onError, callbackURL, mode = "signin", className = "" }: SocialButtonsProps) {
  const t = useExtracted();
  const { configs } = useConfigs();

  // Les boutons étaient auparavant conditionnés à `IS_CLOUD`, un reste du modèle
  // économique de l'amont : en auto-hébergé aucun bouton ne s'affichait, même
  // avec les identifiants OAuth posés dans le job. C'est le serveur qui sait
  // quels identifiants existent réellement, il l'annonce dans /api/config.
  //
  // Tant que la configuration n'est pas chargée, on n'affiche rien : mieux vaut
  // faire apparaître les boutons un instant plus tard que faire clignoter un
  // bouton qui mène à une erreur OAuth.
  const available = configs?.socialProviders;

  const providers: { id: SocialProviderId; enabled: boolean; icon: ReactNode; label: string }[] = [
    {
      id: "google",
      enabled: Boolean(available?.google),
      icon: <Image src="/crawlers/Google.svg" alt="" width={16} height={16} />,
      label: t("Continue with Google"),
    },
    {
      id: "microsoft",
      enabled: Boolean(available?.microsoft),
      icon: <MicrosoftLogo />,
      label: t("Continue with Microsoft"),
    },
    {
      id: "github",
      enabled: Boolean(available?.github),
      icon: <SiGithub />,
      label: t("Continue with GitHub"),
    },
  ];

  const enabledProviders = providers.filter(provider => provider.enabled);

  if (enabledProviders.length === 0) return null;

  const handleSocialAuth = async (provider: SocialProviderId) => {
    try {
      await authClient.signIn.social({
        provider,
        ...(callbackURL ? { callbackURL } : {}),
        // For signup flow, new users should also be redirected to the callbackURL
        ...(mode === "signup" && callbackURL ? { newUserCallbackURL: callbackURL } : {}),
      });
    } catch (error) {
      onError(String(error));
    }
  };

  return (
    <>
      <div className={`flex flex-col gap-2 ${className}`}>
        {enabledProviders.map(provider => (
          <Button key={provider.id} type="button" onClick={() => handleSocialAuth(provider.id)} className="h-11">
            {provider.icon}
            {provider.label}
          </Button>
        ))}
      </div>
      <div className="relative flex items-center text-xs uppercase">
        <div className="flex-1 border-t border-neutral-200 dark:border-neutral-800" />
        <span className="px-3 text-muted-foreground">{t("Or continue with email")}</span>
        <div className="flex-1 border-t border-neutral-200 dark:border-neutral-800" />
      </div>
    </>
  );
}
