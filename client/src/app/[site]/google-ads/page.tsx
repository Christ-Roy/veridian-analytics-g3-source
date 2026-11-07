"use client";

import { useMemo } from "react";
import { Megaphone } from "lucide-react";
import { useExtracted } from "next-intl";
import { useGetAdsCouts, useGetAdsHealth, useGetAdsMappings } from "@/api/google-ads";
import { ErrorState } from "@/components/ErrorState";
import { NothingFound } from "@/components/NothingFound";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSetPageTitle } from "../../../hooks/useSetPageTitle";
import { useStore } from "../../../lib/store";
import { SubHeader } from "../components/SubHeader/SubHeader";
import { Correspondances } from "./components/Correspondances";
import { Depenses } from "./components/Depenses";
import { EtatSante, PastilleEtat } from "./components/EtatSante";

/**
 * L'écran Google Ads du client.
 *
 * Il répond à UNE question, dans cet ordre : est-ce que mes conversions
 * arrivent chez Google, oui ou non. D'où l'état de santé en tête, les
 * correspondances ensuite — car l'état de santé explique la moitié des cas où
 * les correspondances paraissent bonnes.
 *
 * Aucune garde d'accès n'est écrite ici : `[site]/layout.tsx` et `authedFetch`
 * s'en chargent déjà. En rajouter une donnerait deux règles à maintenir, dont
 * une seule serait vraiment appliquée.
 */
export default function GoogleAdsPage() {
  const t = useExtracted();
  useSetPageTitle("Google Ads");

  const { site } = useStore();

  const {
    data: sante,
    isLoading: chargementSante,
    error: erreurSante,
    refetch: rechargerSante,
  } = useGetAdsHealth();

  const { data: correspondances, isLoading: chargementCorrespondances } = useGetAdsMappings();

  /**
   * La période des dépenses est FIXE et non liée au sélecteur global, et c'est
   * délibéré : `AdsHealth` porte l'état de TOUTE la file d'envoi, sans notion
   * de dates (cf. le `hideAnalyticsControls` ci-dessous). Brancher un sélecteur
   * ferait lire une baisse de dépense là où il n'y aurait qu'un changement de
   * bornes, à côté de compteurs qui, eux, ne bougeraient pas.
   *
   * Trente jours glissants, en s'arrêtant HIER : le jour en cours est partiel
   * chez Google, et l'importer ferait afficher une dépense qui baisse d'heure
   * en heure. L'écran affiche ses bornes, plutôt que de laisser deviner
   * pourquoi aujourd'hui manque.
   */
  const { debut, fin } = useMemo(() => {
    const hier = new Date(Date.now() - 86_400_000);
    const debutFenetre = new Date(hier.getTime() - 29 * 86_400_000);
    const jour = (d: Date) => d.toISOString().slice(0, 10);
    return { debut: jour(debutFenetre), fin: jour(hier) };
  }, []);
  const { data: couts, isLoading: chargementCouts } = useGetAdsCouts(debut, fin);

  const chargement = !site || chargementSante;

  return (
    <div className="p-2 md:p-4 max-w-[1400px] mx-auto space-y-3">
      {/* Sans sélecteur de période ni filtres : `AdsHealth` porte l'état de
          TOUTE la file d'envoi, pas d'une fenêtre de dates. Un sélecteur qui ne
          pilote rien ferait lire une baisse là où il n'y a qu'un changement de
          dates. Le `SubHeader` reste, il porte le menu mobile. */}
      <SubHeader hideAnalyticsControls />

      <div className="flex items-center gap-2">
        <Megaphone className="h-5 w-5 text-neutral-600 dark:text-neutral-400" aria-hidden />
        <h1 className="text-lg font-semibold">{t("Google Ads")}</h1>
        {sante ? <PastilleEtat sante={sante} /> : null}
      </div>

      {chargement ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array(4)
              .fill(0)
              .map((_, index) => (
                <Skeleton key={`tuile-${index}`} className="h-20 w-full" />
              ))}
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      ) : erreurSante ? (
        <ErrorState
          title={t("Could not read the Google Ads status")}
          message={
            erreurSante instanceof Error ? erreurSante.message : t("An error occurred while fetching the status")
          }
          refetch={rechargerSante}
        />
      ) : !sante ? (
        <ErrorState
          title={t("Could not read the Google Ads status")}
          message={t("The server answered without a status. Try again in a moment.")}
          refetch={rechargerSante}
        />
      ) : (
        <>
          <EtatSante sante={sante} />

          {/* Les dépenses ne dépendent PAS de `sante.configured` : un site peut
              avoir un compte Ads qui dépense sans qu'aucune conversion ne soit
              encore renvoyée. Les masquer dans ce cas cacherait précisément la
              situation où l'on veut savoir combien part chaque jour. */}
          <Depenses
            totaux={couts?.totaux ?? []}
            campagnes={couts?.campagnes ?? []}
            trafic={couts?.trafic ?? null}
            debut={debut}
            fin={fin}
            chargement={chargementCouts}
          />

          {/* Les correspondances n'ont de sens qu'une fois le compte relié :
              sur un site non configuré, une table vide se lirait comme « il n'y
              a rien à envoyer » alors que rien n'est même branché. */}
          {sante.configured ? (
            <Card>
              <CardContent className="pt-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">{t("Mapped conversions")}</h2>
                  <span className="text-xs text-neutral-600 dark:text-neutral-400">
                    {t("Managed in the site settings")}
                  </span>
                </div>

                {chargementCorrespondances ? (
                  <Skeleton className="h-24 w-full" />
                ) : correspondances && correspondances.mappings.length > 0 ? (
                  <Correspondances correspondances={correspondances.mappings} />
                ) : (
                  <NothingFound
                    icon={<Megaphone className="h-10 w-10" />}
                    title={t("No event is mapped yet")}
                    description={t(
                      "Until an event is mapped to a Google Ads conversion action, nothing will ever be sent, even though the account is connected. Add a mapping in the site settings."
                    )}
                  />
                )}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
