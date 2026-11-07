"use client";
import { ReactNode } from "react";
import { useGetLiveUserCount } from "../../../api/analytics/hooks/useGetLiveUserCount";
import { useInView } from "../../../hooks/useInView";
import { useSetPageTitle } from "../../../hooks/useSetPageTitle";
import { LITE_DASHBOARD } from "../../../lib/const";
import { useStore } from "../../../lib/store";
import { SubHeader } from "../components/SubHeader/SubHeader";
import { MainSection } from "./components/MainSection/MainSection";
import { MainSectionLite } from "./components/MainSection/MainSectionLite";
import { DashboardEpingle } from "./components/sections/DashboardEpingle";
import { Countries } from "./components/sections/Countries";
import { CountriesLite } from "./components/sections/CountriesLite";
import { Devices } from "./components/sections/Devices";
import { DevicesLite } from "./components/sections/DevicesLite";
import { Events } from "./components/sections/Events";
import { GoogleAds } from "./components/sections/GoogleAds";
import { Pages } from "./components/sections/Pages";
import { PagesLite } from "./components/sections/PagesLite";
import { Referrers } from "./components/sections/Referrers";
import { SearchConsole } from "./components/sections/SearchConsole";
import { Weekdays } from "./components/sections/Weekdays";

function LazySection({ children, height = "405px" }: { children: ReactNode; height?: string }) {
  const { ref, isInView } = useInView({ persistVisibility: true, rootMargin: "100px 0px" });
  return (
    <div ref={ref} style={{ minHeight: isInView ? undefined : height }}>
      {isInView ? children : null}
    </div>
  );
}

export default function MainPage() {
  const { site } = useStore();

  if (!site) {
    return null;
  }

  return <MainPageContent />;
}

function MainPageContent() {
  const { data } = useGetLiveUserCount(5);

  useSetPageTitle(`${data?.count ?? "…"} user${data?.count === 1 ? "" : "s"} online`);

  if (LITE_DASHBOARD) {
    return (
      <div className="p-2 md:p-4 max-w-[1100px] mx-auto space-y-3">
        <SubHeader />
        <MainSectionLite />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
          <LazySection>
            <PagesLite />
          </LazySection>
          <LazySection>
            <DevicesLite />
          </LazySection>
          <LazySection>
            <CountriesLite />
          </LazySection>
          <LazySection height="394px">
            <Events />
          </LazySection>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 md:p-4 max-w-[1100px] mx-auto space-y-3">
      <SubHeader />
      <MainSection />
      {/* LE TABLEAU ÉPINGLÉ DU SITE — le pont écrit une seule fois pour ne plus
          jamais coder une carte.

          Robert, le 18/09/2026 : « est-ce qu'il y a réellement besoin de
          modifier la codebase, ou l'outil est-il assez modulable pour mettre à
          jour l'UI de chaque client ? » Il l'est : la table `dashboards` porte
          des cartes en SQL libre avec une API complète, et personne ne s'en
          servait. Ce qu'on s'apprêtait à coter en dur — « ce que le site
          rapporte », formulaires envoyés, créations de compte, commandes — est
          désormais de la CONFIGURATION, une par client, posée par API.

          Placé ici, avant la grille et sans `LazySection`, pour la raison écrite
          plus bas pour Search Console et Google Ads : un bloc monté seulement à
          l'approche de la fenêtre n'existe pas tant qu'on n'a pas scrollé, très
          loin sur mobile en une seule colonne. Mesuré sur la carte qui occupait
          cette place avant : 1932 px du haut sur un écran de 390 px en 4e
          position de grille, 681 px ici.

          Il porte sa propre grille de 12 colonnes, d'où le placement HORS de la
          grille à deux colonnes ci-dessous. Un site sans tableau épinglé ne voit
          aucune différence : le composant rend `null`. */}
      <DashboardEpingle />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
        <LazySection>
          <Referrers />
        </LazySection>
        <LazySection>
          <Pages />
        </LazySection>
        {/* Veridian : upstream réserve Search Console à son offre cloud payante
            (`IS_CLOUD &&`). Le code est pourtant complet des deux côtés —
            server/src/api/gsc/ pour l'OAuth et la récupération, ce composant pour
            l'affichage. On lève la restriction sur notre instance : c'est un fork
            AGPL-3.0 auto-hébergé, et le SEO est un besoin central chez nous.
            Prérequis : GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET dans le job Nomad.

            Placé en 3e position et rendu sans LazySection : en dernier de grille
            et monté à 100 px de la fenêtre, le bloc n'existait pas dans la page
            tant qu'on n'avait pas scrollé tout en bas — très loin sur mobile, en
            une seule colonne. Le SEO est vendu comme bonus commercial : il doit
            se voir. */}
        <SearchConsole />
        {/* Comme Search Console juste au-dessus : rendu sans LazySection. La
            question « est-ce que mes conversions arrivent chez Google » ne doit
            pas dépendre d'un scroll jusqu'en bas de page, très loin sur mobile
            en une seule colonne. */}
        <GoogleAds />
        <LazySection>
          <Devices />
        </LazySection>
        <LazySection>
          <Countries />
        </LazySection>
        <LazySection height="394px">
          <Events />
        </LazySection>
        <LazySection>
          <Weekdays />
        </LazySection>
      </div>
    </div>
  );
}
