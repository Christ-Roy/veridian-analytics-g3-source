"use client";

import { useMeasure } from "@uidotdev/usehooks";
// Veridian : le useMediaQuery de @uidotdev/usehooks LÈVE une erreur pendant le
// rendu serveur ("client-only hook"). Next pré-rend les composants "use client",
// donc la page Replay répondait 500 en accès DIRECT par URL — ce qui casse le
// partage d'un enregistrement à un client par lien privé. Le hook maison, lui,
// n'accède au navigateur que dans un effet : il rend `null` côté serveur.
import useMediaQuery from "@/components/ui/hooks/useMediaQuery";
import { Video } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useGetSessionReplays } from "../../../api/analytics/hooks/sessionReplay/useGetSessionReplays";
import { DisabledOverlay } from "../../../components/DisabledOverlay";
import { NothingFound } from "../../../components/NothingFound";
import { ReplayBreadcrumbs } from "@/components/replay/ReplayBreadcrumbs";
import { ReplayPlayer } from "@/components/replay/player/ReplayPlayer";
import { ReplayDrawer } from "@/components/Sessions/ReplayDrawer";
import { useReplayStore } from "@/components/replay/replayStore";
import { useSetPageTitle } from "../../../hooks/useSetPageTitle";
import { SESSION_REPLAY_PAGE_FILTERS } from "../../../lib/filterGroups";
import { SubHeader } from "../components/SubHeader/SubHeader";
import { EnableSessionReplay } from "./components/EnableSessionReplay";
import { ReplayList } from "./components/ReplayList";
import { useAppEnv } from "../../../hooks/useIsProduction";

export default function SessionReplayPage() {
  const t = useExtracted();
  useSetPageTitle("Session Replay");
  const appEnv = useAppEnv();

  const { minDuration, sessionId } = useReplayStore(
    useShallow(s => ({ minDuration: s.minDuration, sessionId: s.sessionId }))
  );

  const { data, isLoading } = useGetSessionReplays({ minDuration });
  const hasNoReplays = !isLoading && !data?.pages[0].data?.length;

  // On narrow screens the player can't sit beside the list, so selecting a
  // replay opens the fullscreen drawer (player + timeline) instead.
  const isCompact = useMediaQuery("(max-width: 767px)");
  const [mobileOpen, setMobileOpen] = useState(false);

  const [playerRef, { width: playerWidth, height: playerHeight }] = useMeasure();

  // Veridian : ce retour anticipé était placé AVANT les six hooks ci-dessus.
  // `useAppEnv` lit `window.location.hostname`, donc il rend `null` au
  // pré-rendu et `"demo"` après hydratation : le nombre de hooks changeait
  // entre les deux rendus et React levait « Rendered fewer hooks than
  // expected », écran blanc sur l'instance de démonstration uniquement. Le
  // test de l'environnement doit donc venir après TOUS les hooks.
  if (appEnv === "demo") return null;

  return (
    <DisabledOverlay message="Replay" featurePath="replay" requiredPlan="pro">
      <div className="flex flex-col h-dvh overflow-hidden p-2 md:p-4 gap-3 max-w-[2000px] mx-auto">
        <div className="shrink-0">
          <SubHeader availableFilters={SESSION_REPLAY_PAGE_FILTERS} />
        </div>
        {/* Renders null in the common case, so it adds no flex gap. */}
        <EnableSessionReplay />

        {hasNoReplays ? (
          <div className="flex flex-1 items-center justify-center">
            <NothingFound
              icon={<Video className="w-10 h-10" />}
              title={t("No session replays found")}
              description={t("Replays will appear here once session replay is enabled.")}
            />
          </div>
        ) : (
          <div className="flex gap-3 flex-1 min-h-0">
            {/* List */}
            <div className="w-full md:w-[200px] lg:w-[210px] shrink-0 min-h-0">
              <ReplayList onSelect={isCompact ? () => setMobileOpen(true) : undefined} />
            </div>

            {/* Player */}
            <div ref={playerRef} className="hidden md:block flex-1 min-w-0 overflow-hidden">
              {playerWidth && playerHeight ? <ReplayPlayer width={playerWidth} height={playerHeight} /> : null}
            </div>

            {/* Timeline */}
            <div className="hidden xl:block w-[300px] shrink-0 min-h-0">
              <ReplayBreadcrumbs />
            </div>
          </div>
        )}

        {isCompact && <ReplayDrawer sessionId={sessionId} open={mobileOpen} onOpenChange={setMobileOpen} />}
      </div>
    </DisabledOverlay>
  );
}
