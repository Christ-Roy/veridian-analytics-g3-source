import { SiGoogle } from "@icons-pack/react-simple-icons";
import { Expand, Info } from "lucide-react";
import { useExtracted } from "next-intl";
import { Button } from "../../../../../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../../../components/ui/tooltip";

/**
 * Veridian : la carte Search Console n'affichait que ses quatre onglets
 * (« Mots-clés | Pages | Pays | Appareils ») une fois connectée. Le mot
 * « Search Console » et le logo Google n'apparaissaient QUE dans l'état
 * déconnecté, sur le bouton — donc un client connecté ne pouvait pas savoir que
 * ces chiffres viennent de Google plutôt que de son propre tracker. Ce bandeau
 * nomme la source, et affiche la propriété Google reliée comme preuve du
 * branchement.
 */
export function SearchConsoleHeader({
  propertyUrl,
  onToggleExpand,
}: {
  propertyUrl?: string | null;
  onToggleExpand?: () => void;
}) {
  const t = useExtracted();

  // Une propriété Domaine est stockée « sc-domain:exemple.fr » : le préfixe est
  // un détail d'API Google, il n'apprend rien au client.
  const property = propertyUrl?.replace(/^sc-domain:/, "");

  return (
    <div className="flex flex-row gap-2 justify-between items-center mb-3">
      <div className="flex flex-row gap-2 items-center min-w-0">
        <SiGoogle className="w-4 h-4 shrink-0 text-neutral-500 dark:text-neutral-400" aria-hidden />
        <span className="text-sm font-medium truncate">{t("Search Console")}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="shrink-0 text-neutral-500 dark:text-neutral-400">
              <Info className="w-3.5 h-3.5" />
              <span className="sr-only">{t("About Search Console")}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {t(
              "Search results on Google: what visitors typed to find you, and which pages they landed on. Google publishes this data with a 2-3 day delay."
            )}
          </TooltipContent>
        </Tooltip>
        {property ? (
          <span className="hidden sm:inline text-xs text-neutral-500 dark:text-neutral-400 truncate" title={property}>
            {property}
          </span>
        ) : null}
      </div>
      {onToggleExpand ? (
        <Button size="smIcon" onClick={onToggleExpand} aria-label={t("Expand")}>
          <Expand className="w-4 h-4" />
        </Button>
      ) : null}
    </div>
  );
}
