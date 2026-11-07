"use client";

import "react-grid-layout/css/styles.css";
// 🔴 LES DEUX FEUILLES, PAS UNE. react-grid-layout rend TOUJOURS un nœud de
// poignée de redimensionnement, même sur une carte `static` : il se contente de
// poser la classe `react-resizable-hide` sur l'élément. C'est
// `react-resizable/css/styles.css` qui donne son effet à cette classe. Sans cet
// import, la poignée est bien là et VISIBLE — un petit triangle à tirer dans le
// coin de chaque carte, sur le tableau de bord d'un client. Un test le tient.
import "react-resizable/css/styles.css";

import type { Dashboard, DashboardCard } from "@rybbit/shared";
import { Info, SquareArrowOutUpRight } from "lucide-react";
import { useExtracted } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import { useGetDashboards } from "../../../../../api/analytics/hooks/useDashboards";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../../../components/ui/tooltip";
import { useStore } from "../../../../../lib/store";
import { getSiteRouteContext } from "../../../../../lib/siteRoute";
import { DashboardCardView } from "../../../dashboards/components/DashboardCardView";
import {
  DASHBOARD_BREAKPOINTS,
  DASHBOARD_GRID_COLS,
  DASHBOARD_ROW_HEIGHT,
} from "../../../dashboards/utils";

const GrilleResponsive = WidthProvider(Responsive);

/**
 * Le tableau de bord ÉPINGLÉ du site, rendu en tête de la vue d'ensemble.
 *
 * ── Pourquoi ce composant existe ──────────────────────────────────────────
 *
 * Robert, le 18/09/2026 : « est-ce qu'il y a réellement besoin de modifier la
 * codebase, ou l'outil est-il assez modulable pour mettre à jour l'UI de chaque
 * client ? » Il est assez modulable, et personne ne s'en servait : la table
 * `dashboards` porte des cartes en SQL libre, avec neuf visualisations et une
 * API complète, et zéro tableau existait en production.
 *
 * Ce fichier est donc le PONT, écrit une seule fois : à partir de là, la carte
 * de conversion d'un client se crée et se modifie par API, sans toucher au
 * code. C'est la seule chose qui devait être codée.
 *
 * ── Ce qu'il ne fait jamais ───────────────────────────────────────────────
 *
 * Un site sans tableau épinglé ne voit AUCUNE différence : pas de bloc vide,
 * pas de cadre en attente, pas d'invitation à configurer. Le composant rend
 * `null`. La même chose vaut pendant le chargement — un cadre qui apparaît
 * puis disparaît fait sauter toute la page — et en cas d'erreur de lecture.
 *
 * ⚠️ L'erreur silencieuse est ici un CHOIX, contrairement à la règle
 * habituelle. `GET /sites/:id/dashboards` exige une session
 * (`authDashboardsRead`, et non `publicSiteScoped` comme les objectifs) : sur
 * un site public ou derrière un lien d'embarquement, la lecture répond 403.
 * Afficher « impossible de lire vos tableaux » sur le tableau de bord d'un
 * prospect serait un défaut visible là où il n'y a rien de cassé. La
 * contrepartie est réelle et assumée : un tableau épinglé ne se voit PAS sur
 * une vue publique. Pour l'y amener il faudrait rendre publiques la liste ET
 * l'exécution de SQL arbitraire — c'est un arbitrage de sécurité, pas une
 * ligne de code, et il n'est pas pris ici.
 */
export function DashboardEpingle() {
  const t = useExtracted();
  const pathname = usePathname();
  const site = useStore(state => state.site);
  const filtres = useStore(state => state.filters);
  const { siteId: siteDuChemin, privateKey } = getSiteRouteContext(pathname);

  const { data: tableaux, isLoading, error } = useGetDashboards(site);

  const epingle: Dashboard | undefined = useMemo(
    () => (tableaux ?? []).find(tableau => tableau.pinned),
    [tableaux]
  );
  const cartes: DashboardCard[] = epingle?.config?.cards ?? [];

  // 🔴 Toutes les portes de sortie AVANT tout rendu, et aucun hook après.
  if (isLoading || error || !epingle || cartes.length === 0 || !site) return null;

  const lien = siteDuChemin
    ? privateKey
      ? `/${siteDuChemin}/${privateKey}/dashboards/${epingle.dashboardId}`
      : `/${siteDuChemin}/dashboards/${epingle.dashboardId}`
    : null;

  // `static` NE SUFFIT PAS, et un test l'a montré : react-grid-layout rendait
  // quand même une poignée de redimensionnement, invisible faute de feuille de
  // style mais bien présente dans le document — un élément qui traîne sur le
  // tableau de bord d'un client, et qu'on finit par tirer. Les deux drapeaux
  // par carte sont donc posés en plus, explicitement.
  const disposition: Layout[] = cartes.map(carte => ({
    i: carte.id,
    x: carte.gridPos.x,
    y: carte.gridPos.y,
    w: carte.gridPos.w,
    h: carte.gridPos.h,
    static: true,
    isDraggable: false,
    isResizable: false,
  }));

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{epingle.name}</span>
          {filtres.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex shrink-0 items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                  <Info className="h-3 w-3" aria-hidden />
                  {t("Filters not applied")}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {t(
                  "These cards run their own query and follow the selected period, but not the page filters. Their figures cover the whole site."
                )}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        {lien ? (
          <Link
            href={lien}
            className="flex shrink-0 items-center gap-1 text-xs text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            {t("Details")}
            <SquareArrowOutUpRight className="h-3 w-3" />
          </Link>
        ) : null}
      </div>

      {/* Le MÊME moteur que l'onglet Dashboards — même composant de carte, même
          géométrie de grille. Réécrire le rendu ici aurait produit deux
          affichages qui divergent, et un client qui voit deux chiffres
          différents pour une même carte selon la page où il la regarde.
          Seules l'édition et le déplacement sont coupés : `static: true` sur
          chaque carte, plus `isDraggable`/`isResizable` à faux. */}
      <GrilleResponsive
        className="layout"
        layouts={{
          lg: disposition,
          md: disposition,
          sm: disposition,
          xs: disposition,
          xxs: disposition,
        }}
        breakpoints={DASHBOARD_BREAKPOINTS}
        cols={DASHBOARD_GRID_COLS}
        rowHeight={DASHBOARD_ROW_HEIGHT}
        margin={[12, 12]}
        containerPadding={[0, 0]}
        isDraggable={false}
        isResizable={false}
      >
        {cartes.map(carte => (
          <div key={carte.id} className="rounded-lg">
            <DashboardCardView
              siteId={Number(site)}
              card={carte}
              editMode={false}
              onEdit={() => {}}
              onClone={() => {}}
              onRemove={() => {}}
            />
          </div>
        ))}
      </GrilleResponsive>
    </div>
  );
}
