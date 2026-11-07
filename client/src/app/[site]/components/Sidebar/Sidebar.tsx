"use client";
import {
  AlertTriangle,
  Bot,
  ChartColumnDecreasing,
  Code,
  Database,
  File,
  Flag,
  FlaskConical,
  Funnel,
  Gauge,
  Globe2,
  LayoutDashboard,
  LayoutGrid,
  Megaphone,
  MousePointerClick,
  Rewind,
  Settings,
  Split,
  Target,
  User,
  Video,
} from "lucide-react";
import { useExtracted } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useGetSite } from "../../../../api/admin/hooks/useSites";
import { Sidebar as SidebarComponents } from "../../../../components/sidebar/Sidebar";
import { SiteSettings } from "../../../../components/SiteSettings/SiteSettings";
import { DEMO_HOSTNAME, IS_CLOUD } from "../../../../lib/const";
import { getSiteRouteContext } from "../../../../lib/siteRoute";
import { useEmbedPageOptions } from "../../utils";
import { SiteSelector } from "./SiteSelector";
import { useStripeSubscription } from "../../../../lib/subscription/useStripeSubscription";
import { useAppEnv } from "../../../../hooks/useIsProduction";

function SidebarContent() {
  const t = useExtracted();
  const { data: subscription, isLoading: isSubscriptionLoading } = useStripeSubscription();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { embed, hideSidebar } = useEmbedPageOptions();
  const appEnv = useAppEnv();

  const { data: site } = useGetSite(Number(pathname.split("/")[1]));
  const isMobileSite = site?.type === "mobile";

  if (hideSidebar) return null;

  const { privateKey } = getSiteRouteContext(pathname);

  // Check which tab is active based on the current path
  const getTabPath = (tabName: string) => {
    const { siteId, privateKey } = getSiteRouteContext(pathname);

    // Build path: /siteId/[privateKey]/tabName
    const basePath = privateKey
      ? `/${siteId}/${privateKey}/${tabName.toLowerCase()}`
      : `/${siteId}/${tabName.toLowerCase()}`;
    const queryString = searchParams.toString();

    return queryString ? `${basePath}?${queryString}` : basePath;
  };

  const isActiveTab = (tabName: string) => {
    if (!pathname.includes("/")) return false;

    const route = getSiteRouteContext(pathname).route ?? "main";
    return route === tabName.toLowerCase();
  };

  return (
    <div className="w-56 bg-neutral-50 border-r border-neutral-150 dark:bg-neutral-900 dark:border-neutral-850 flex flex-col h-dvh">
      <div className="flex flex-col p-3 border-b border-neutral-200 dark:border-neutral-800">
        <SiteSelector />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 pt-1">
        <SidebarComponents.SectionHeader>
          {isMobileSite ? t("App Analytics") : t("Web Analytics")}
        </SidebarComponents.SectionHeader>
        <SidebarComponents.Item
          label={t("Main")}
          active={isActiveTab("main")}
          href={getTabPath("main")}
          icon={<LayoutDashboard className="w-4 h-4" />}
        />
        <SidebarComponents.Item
          label={t("Globe")}
          active={isActiveTab("globe")}
          href={getTabPath("globe")}
          icon={<Globe2 className="w-4 h-4" />}
        />
        {/* Pages, Performance et Bots etaient enveloppes dans `IS_CLOUD`, c'est-a-dire
            reserves aux clients payants de l'offre cloud de l'amont. Ce n'est pas une
            limite technique : verifie le 31/08/2026 en ouvrant /19/pages a la main sur
            notre instance, la page rend les vraies donnees du site (vues, sessions,
            rebond, duree). Seule l'entree de menu manquait.

            On RETIRE la condition, on ne bascule PAS `NEXT_PUBLIC_CLOUD` : le drapeau
            porte aussi la condition INVERSE plus bas (`{!IS_CLOUD && ...}`), donc
            l'activer ferait disparaitre `Requete` et `Tableaux de bord`, en plus
            d'allumer la facturation Stripe et le bridage par abonnement.

            Meme geste que pour Google Ads quelques lignes plus bas. */}
        <SidebarComponents.Item
          label={t("Pages")}
          active={isActiveTab("pages")}
          href={getTabPath("pages")}
          icon={<File className="w-4 h-4" />}
        />
        {!isMobileSite && (
          <SidebarComponents.Item
            label={t("Performance")}
            active={isActiveTab("performance")}
            href={getTabPath("performance")}
            icon={<Gauge className="w-4 h-4" />}
          />
        )}
        <SidebarComponents.Item
          label={t("Bots")}
          active={isActiveTab("bots")}
          href={getTabPath("bots")}
          icon={<Bot className="w-4 h-4" />}
        />
        <SidebarComponents.Item
          label={t("Goals")}
          active={isActiveTab("goals")}
          href={getTabPath("goals")}
          icon={<Target className="w-4 h-4" />}
        />
        {/* 🔴 `getTabPath` construit le chemin à partir de ce nom, en minuscules :
            il doit rester EXACTEMENT le nom du dossier de route
            (`app/[site]/google-ads/`), sinon le lien pointe dans le vide sans
            que rien ne le signale. Le libellé traduit est à part.
            Sans condition `IS_CLOUD` : ce fork a levé ces verrous. */}
        <SidebarComponents.Item
          label={t("Google Ads")}
          active={isActiveTab("google-ads")}
          href={getTabPath("google-ads")}
          icon={<Megaphone className="w-4 h-4" />}
        />
        <div className="hidden md:block">
          <SidebarComponents.Item
            label={t("API Playground")}
            active={isActiveTab("api-playground")}
            href={getTabPath("api-playground")}
            icon={<Code className="w-4 h-4" />}
          />
        </div>
        {!IS_CLOUD && (
          <>
            <SidebarComponents.Item
              label={t("Query")}
              active={isActiveTab("query")}
              href={getTabPath("query")}
              icon={<Database className="w-4 h-4" />}
            />
            <SidebarComponents.Item
              label={t("Dashboards")}
              active={isActiveTab("dashboards")}
              href={getTabPath("dashboards")}
              icon={<LayoutGrid className="w-4 h-4" />}
            />
          </>
        )}
        <SidebarComponents.SectionHeader>{t("Product Analytics")}</SidebarComponents.SectionHeader>
        <div className="hidden md:block">
          {!isMobileSite &&
            !subscription?.planName?.startsWith("appsumo") &&
            !isSubscriptionLoading &&
            appEnv !== "demo" && (
              <SidebarComponents.Item
                label={t("Replay")}
                active={isActiveTab("replay")}
                href={getTabPath("replay")}
                icon={<Video className="w-4 h-4" />}
              />
            )}
        </div>
        {/* Feature Flags et Experiments etaient commentes en bloc chez l'amont, qui les
            reserve a son offre cloud payante. Ce ne sont pas des chantiers inacheves :
            verifie le 01/09/2026 en ouvrant /19/feature-flags et /19/experiments a la
            main sur notre instance de production.

            - Feature Flags rend son etat vide traduit puis son dialogue complet :
              booleen / variantes multiples / config JSON distante, conditions de
              deploiement ordonnees, regles de ciblage, pourcentage de deploiement,
              charge utile JSON, environnement client / serveur / les deux.
              Six routes serveur branchees (server/src/index.ts:411-416), scopees par
              droits, et le script de tracking sait les evaluer
              (analytics-script : `featureFlagsEnabled`, POST /site/:siteId/feature-flags/evaluate,
              couvert par tracking.test.ts). La chaine est complete de bout en bout.
            - Experiments rend son assistant en 4 etapes (Bases / Assignation / Objectif /
              Implementer), traduit lui aussi. Cinq routes serveur (index.ts:417-421),
              resultats compris. Il s'appuie sur un feature flag multivariante, d'ou
              l'interet de rallumer les deux ensemble : l'un sans l'autre est un cul-de-sac.

            `Reports` reste commente plus bas, et c'est justifie : sa page est un
            placeholder et il n'a AUCUNE route serveur. On ne rallume pas ce qui est vide.

            Le garde `!privateKey` est conserve : ce sont des ecrans d'ECRITURE, ils
            n'ont rien a faire sur un lien de partage en lecture seule. */}
        {!privateKey && (
          <SidebarComponents.Item
            label={t("Feature Flags")}
            active={isActiveTab("feature-flags")}
            href={getTabPath("feature-flags")}
            icon={<Flag className="w-4 h-4" />}
          />
        )}
        {!privateKey && (
          <SidebarComponents.Item
            label={t("Experiments")}
            active={isActiveTab("experiments")}
            href={getTabPath("experiments")}
            icon={<FlaskConical className="w-4 h-4" />}
          />
        )}
        <SidebarComponents.Item
          label={t("Funnels")}
          active={isActiveTab("funnels")}
          href={getTabPath("funnels")}
          icon={<Funnel className="w-4 h-4" />}
        />
        <SidebarComponents.Item
          label={t("Journeys")}
          active={isActiveTab("journeys")}
          href={getTabPath("journeys")}
          icon={<Split className="w-4 h-4" />}
        />
        <SidebarComponents.Item
          label={t("Retention")}
          active={isActiveTab("retention")}
          href={getTabPath("retention")}
          icon={<ChartColumnDecreasing className="w-4 h-4" />}
        />
        <SidebarComponents.SectionHeader>{t("Behavior")}</SidebarComponents.SectionHeader>
        <SidebarComponents.Item
          label={t("Sessions")}
          active={isActiveTab("sessions")}
          href={getTabPath("sessions")}
          icon={<Rewind className="w-4 h-4" />}
        />
        <SidebarComponents.Item
          label={t("Users")}
          active={isActiveTab("users")}
          href={getTabPath("users")}
          icon={<User className="w-4 h-4" />}
        />
        <SidebarComponents.Item
          label={t("Events")}
          active={isActiveTab("events")}
          href={getTabPath("events")}
          icon={<MousePointerClick className="w-4 h-4" />}
        />
        <SidebarComponents.Item
          label={t("Errors")}
          active={isActiveTab("errors")}
          href={getTabPath("errors")}
          icon={<AlertTriangle className="w-4 h-4" />}
        />
        {/* <SidebarComponents.Item
          label="Reports"
          active={isActiveTab("reports")}
          href={getTabPath("reports")}
          icon={<ChartBarDecreasing className="w-4 h-4" />}
          /> */}
        {!embed && (
          <>
            <SidebarComponents.SectionHeader>{t("Settings")}</SidebarComponents.SectionHeader>
            <SiteSettings
              siteId={site?.siteId ?? 0}
              trigger={
                <div className="px-3 py-2 rounded-lg transition-colors w-full text-neutral-700 hover:text-neutral-900 hover:bg-neutral-150 dark:text-neutral-200 dark:hover:text-white dark:hover:bg-neutral-800/50 cursor-pointer">
                  <div className="flex items-center gap-2">
                    <Settings className="h-4 w-4" />
                    <span className="text-sm">{t("Site Settings")}</span>
                  </div>
                </div>
              }
            />
          </>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <Suspense fallback={null}>
      <SidebarContent />
    </Suspense>
  );
}
