"use client";
import { Button } from "@/components/ui/button";
import { canGoForward, goBack, goForward, useStore } from "@/lib/store";
import { FilterParameter } from "@rybbit/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Filters } from "./Filters/Filters";

import { DateSelector } from "../../../../components/DateSelector/DateSelector";
import { MobileSidebar } from "../Sidebar/MobileSidebar";
import { NewFilterButton } from "./Filters/NewFilterButton";
import { LiveUserCount } from "./LiveUserCount";
import { ShareExportButton } from "./ShareExportButton";

export function SubHeader({
  availableFilters,
  hideAnalyticsControls = false,
}: {
  availableFilters?: FilterParameter[];
  /**
   * Retire le sélecteur de période, les flèches de navigation temporelle et les
   * filtres, en gardant le menu mobile et le compteur temps réel.
   *
   * Réservé aux écrans dont les chiffres ne DÉPENDENT pas de la période choisie
   * (l'état d'envoi Google Ads porte sur toute la file, pas sur une fenêtre).
   * Un contrôle qui ne pilote rien est pire qu'un contrôle absent : le client
   * change les dates, voit des chiffres immobiles, et en tire une conclusion
   * fausse sans que rien ne le détrompe.
   *
   * Par défaut à `false` : les quinze autres pages gardent exactement le
   * comportement actuel.
   */
  hideAnalyticsControls?: boolean;
}) {
  const { time, setTime } = useStore();

  return (
    <div>
      <div className="flex gap-2 justify-between">
        <div className="flex items-center gap-2">
          <MobileSidebar />
          {!hideAnalyticsControls && (
            <div className="hidden md:block">
              <NewFilterButton availableFilters={availableFilters} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <LiveUserCount />
          <ShareExportButton />
          {!hideAnalyticsControls && (
            <>
              <DateSelector time={time} setTime={setTime} />
              <div className="flex items-center">
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={goBack}
                  disabled={time.mode === "past-minutes"}
                  className="rounded-r-none h-8 w-8"
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  onClick={goForward}
                  disabled={!canGoForward(time)}
                  className="rounded-l-none -ml-px h-8 w-8"
                >
                  <ChevronRight />
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
      {!hideAnalyticsControls && (
        <div>
          <div className="md:hidden mt-3">
            <NewFilterButton availableFilters={availableFilters} />
          </div>
          <div className="mt-2">
            <Filters availableFilters={availableFilters} />
          </div>
        </div>
      )}
    </div>
  );
}
