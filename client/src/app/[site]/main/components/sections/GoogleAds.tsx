"use client";

import { AlertTriangle, CircleDashed, CircleSlash, Megaphone, Send, SquareArrowOutUpRight, XCircle } from "lucide-react";
import { useExtracted } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useGetAdsHealth } from "../../../../../api/google-ads";
import { ErrorState } from "../../../../../components/ErrorState";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardContent, CardLoader } from "../../../../../components/ui/card";
import { getSiteRouteContext } from "../../../../../lib/siteRoute";
import { BandeauModeEssai } from "../../../google-ads/components/EtatSante";
import { dureeCourte, envoiArrete } from "../../../google-ads/temps";

// Même hauteur de grille que les cartes voisines : une carte qui dépasse
// décale toute sa ligne.
const HAUTEUR_CARTE = "h-[405px]";

function Entete({ children }: { children?: ReactNode }) {
  const t = useExtracted();

  return (
    <div className="flex items-center justify-between gap-2 py-2">
      <div className="flex items-center gap-2">
        <Megaphone className="h-4 w-4 text-neutral-600 dark:text-neutral-400" aria-hidden />
        <span className="text-sm font-medium">{t("Google Ads")}</span>
      </div>
      {children}
    </div>
  );
}

function Ligne({
  libelle,
  valeur,
  couleur,
  icone,
}: {
  libelle: string;
  valeur: number;
  couleur: string;
  icone: ReactNode;
}) {
  // Un zéro reste neutre : « 0 échec » n'est pas rouge, « 0 envoyée » n'est pas vert.
  const teinte = valeur === 0 ? "text-neutral-900 dark:text-neutral-100" : couleur;

  return (
    <div className="rounded-lg border border-neutral-100 dark:border-neutral-850 p-3">
      <div className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
        {icone}
        {libelle}
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${teinte}`}>{valeur.toLocaleString()}</div>
    </div>
  );
}

/**
 * L'invitation à brancher le module. Elle est délibérément différente d'un
 * écran de compteurs à zéro : « pas encore branché » et « branché, rien envoyé »
 * demandent des gestes opposés, et les confondre fait chercher une panne
 * inexistante.
 */
function InviteConfiguration({ href }: { href: string | null }) {
  const t = useExtracted();

  return (
    <div className="flex h-[340px] flex-col items-center justify-center gap-3 px-4">
      <Megaphone className="h-7 w-7 text-neutral-400 dark:text-neutral-500" aria-hidden />
      <div className="text-center text-sm font-medium">{t("Google Ads is not connected yet")}</div>
      <div className="max-w-sm text-center text-sm text-neutral-600 dark:text-neutral-400">
        {t(
          "Connect your Google Ads account to send your conversions back to Google, so it can optimise your campaigns on what actually converts."
        )}
      </div>
      {href ? (
        <Button asChild variant="outline" size="sm">
          <Link href={href}>{t("Set up Google Ads")}</Link>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * La carte Google Ads du tableau de bord : le strict nécessaire pour savoir si
 * les conversions partent, et un lien vers l'écran complet pour le reste.
 */
export function GoogleAds() {
  const t = useExtracted();
  const pathname = usePathname();
  const { siteId, privateKey } = getSiteRouteContext(pathname);
  const lien = siteId ? (privateKey ? `/${siteId}/${privateKey}/google-ads` : `/${siteId}/google-ads`) : null;

  const { data: sante, isLoading, error, refetch } = useGetAdsHealth();

  if (isLoading) {
    return (
      <Card className={HAUTEUR_CARTE}>
        <CardLoader />
        <CardContent className="mt-2">
          <Entete />
        </CardContent>
      </Card>
    );
  }

  // 🔴 L'erreur de chargement AVANT l'absence de configuration, et jamais
  // l'inverse. Sans cette branche, une requête en échec laisse `sante` à
  // `undefined`, donc `!sante?.configured` est vrai, et la carte annonce
  // « Google Ads n'est pas encore branché » avec un bouton « Configurer » sur un
  // compte parfaitement relié. Le client reconfigure alors un module qui
  // marchait, ou conclut que le produit a perdu ses réglages : c'est une panne
  // déguisée en état normal, exactement ce qu'aucun compteur ne signale.
  if (error) {
    return (
      <Card className={HAUTEUR_CARTE}>
        <CardContent className="mt-2">
          <Entete />
          <ErrorState
            title={t("Could not read the Google Ads status")}
            message={error instanceof Error ? error.message : t("An error occurred while fetching the status")}
            refetch={refetch}
          />
        </CardContent>
      </Card>
    );
  }

  if (!sante?.configured) {
    return (
      <Card className={HAUTEUR_CARTE}>
        <CardContent className="mt-2">
          <Entete />
          <InviteConfiguration href={lien} />
        </CardContent>
      </Card>
    );
  }

  // Le seuil et le format vivent dans `google-ads/temps` : la carte dit la même
  // chose que la page, au mot près, parce qu'elle lit la même règle.
  const retard = sante.oldestOverdueBy;
  const fileBloquee = envoiArrete(retard);
  const rienRecu = sante.pending === 0 && sante.sent === 0 && sante.failed === 0 && sante.skipped === 0;

  return (
    <Card className={HAUTEUR_CARTE}>
      <CardContent className="mt-2 space-y-3">
        <Entete>
          {lien ? (
            <Link
              href={lien}
              className="flex items-center gap-1 text-xs text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              {t("Details")}
              <SquareArrowOutUpRight className="h-3 w-3" />
            </Link>
          ) : null}
        </Entete>

        <BandeauModeEssai actif={sante.testMode} />

        <div className="grid grid-cols-2 gap-2">
          <Ligne
            libelle={t("Pending")}
            valeur={sante.pending}
            couleur="text-yellow-600 dark:text-yellow-400"
            icone={<CircleDashed className="h-3.5 w-3.5" />}
          />
          <Ligne
            libelle={t("Sent")}
            valeur={sante.sent}
            couleur="text-emerald-600 dark:text-emerald-400"
            icone={<Send className="h-3.5 w-3.5" />}
          />
          <Ligne
            libelle={t("Failed")}
            valeur={sante.failed}
            couleur="text-red-600 dark:text-red-400"
            icone={<XCircle className="h-3.5 w-3.5" />}
          />
          <Ligne
            libelle={t("Discarded")}
            valeur={sante.skipped}
            couleur="text-neutral-600 dark:text-neutral-400"
            icone={<CircleSlash className="h-3.5 w-3.5" />}
          />
        </div>

        <div className="space-y-1.5 text-xs">
          {fileBloquee ? (
            <div className="flex items-start gap-1.5 text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {t("An upload was due {retard} ago and never ran: the sender has stopped.", {
                  retard: dureeCourte(retard ?? 0),
                })}
              </span>
            </div>
          ) : null}

          {sante.mappings === 0 ? (
            <div className="flex items-start gap-1.5 text-yellow-600 dark:text-yellow-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("No event is mapped, so nothing will ever be sent.")}</span>
            </div>
          ) : rienRecu ? (
            <div className="text-neutral-600 dark:text-neutral-400">
              {t("Set up and waiting: no conversion has been recorded yet.")}
            </div>
          ) : null}

          {sante.zeroValueSent > 0 ? (
            <div className="flex items-start gap-1.5 text-yellow-600 dark:text-yellow-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("{count} sent with no amount, so the reported ROAS is understated.", { count: String(sante.zeroValueSent) })}</span>
            </div>
          ) : null}

          {!sante.enabled ? <Badge variant="secondary">{t("Sending paused")}</Badge> : null}
        </div>
      </CardContent>
    </Card>
  );
}
