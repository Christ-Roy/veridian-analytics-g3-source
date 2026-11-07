import { useState } from "react";
import { faviconUrl } from "../lib/favicon";
import { cn } from "../lib/utils";

export function Favicon({ domain, className }: { domain: string; className?: string }) {
  // Rang dans FAVICON_PATHS : chaque échec de chargement passe au chemin
  // suivant, et l'épuisement de la liste retombe sur l'initiale. Le domaine
  // est porté dans le même état parce que ce composant est réutilisé d'une
  // ligne à l'autre (sélecteur de site, tableaux) : sans ça, un domaine qui a
  // épuisé ses chemins condamnerait le suivant à l'initiale.
  const [progress, setProgress] = useState({ domain, attempt: 0 });
  const attempt = progress.domain === domain ? progress.attempt : 0;
  const firstLetter = domain.charAt(0).toUpperCase();
  // Icône servie par le domaine lui-même, jamais par un service tiers : voir
  // lib/favicon.ts pour ce que l'appel à DuckDuckGo faisait fuiter.
  const src = faviconUrl(domain, attempt);

  if (!src) {
    return (
      <div
        className={cn(
          "bg-neutral-700 rounded-full flex items-center justify-center text-xs font-medium text-white",
          className ?? "w-4 h-4"
        )}
      >
        {firstLetter}
      </div>
    );
  }

  return (
    <img
      // Repartir d'un <img> neuf à chaque chemin : sans clé, React réutilise
      // l'élément en échec et le navigateur ne rejoue pas le chargement.
      key={src}
      src={src}
      className={cn(className ?? "w-4 h-4")}
      alt={`Favicon for ${domain}`}
      // Le domaine ne doit pas apprendre d'où vient la requête : sans ça, il
      // verrait `analytics.app.veridian.site` en référent à chaque affichage.
      // (Pas de `crossOrigin` : il exigerait des en-têtes CORS que presque
      // aucun site ne pose sur son favicon, et l'icône ne s'afficherait plus.)
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setProgress({ domain, attempt: attempt + 1 })}
    />
  );
}
