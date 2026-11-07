/**
 * Pied de page.
 *
 * Remplace les 223 lignes de promotion de l'éditeur amont (parrainage GitHub,
 * Discord, X, programme d'affiliation 50 %, liens rybbit.com, contact éditeur,
 * « Made with ❤️ by frogs ») par un pied de page Veridian sobre.
 *
 * Le drapeau `BRAND.showUpstreamPromotion` garde la suppression explicite et
 * réversible : on n'a pas effacé du code au hasard, on l'a débranché.
 */
import Link from "next/link";
import { useWhiteLabel } from "../../hooks/useIsWhiteLabel";
import { BRAND, brandYear } from "../../lib/brand";

interface FooterProps {
  disabled?: boolean;
}

export function Footer({ disabled = false }: FooterProps) {
  const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION;
  const { isWhiteLabel } = useWhiteLabel();

  if (disabled || isWhiteLabel) {
    return null;
  }

  return (
    <footer className="border-t border-neutral-200 dark:border-neutral-850 bg-neutral-50 dark:bg-neutral-900">
      <div className="max-w-[1100px] mx-auto px-4 py-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4 text-sm text-neutral-500 dark:text-neutral-400">
            <span>
              © {brandYear()} {BRAND.shortName}
            </span>
            <Link href={BRAND.urls.support} className="hover:text-neutral-700 dark:hover:text-neutral-300">
              Assistance
            </Link>
            {/*
              L'AGPL-3.0 impose de proposer la source aux utilisateurs servis par
              le réseau. On assume le fork : le lien reste, discret.
            */}
            <Link
              href={BRAND.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-neutral-700 dark:hover:text-neutral-300"
            >
              Code source
            </Link>
          </div>
          <div className="flex items-center gap-4">
            {APP_VERSION && <span className="text-sm text-neutral-500 dark:text-neutral-400">v{APP_VERSION}</span>}
          </div>
        </div>
      </div>
    </footer>
  );
}
