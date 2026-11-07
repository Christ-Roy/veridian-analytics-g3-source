/**
 * Icône d'un domaine — SANS tiers.
 *
 * Amont demandait ces icônes à `icons.duckduckgo.com`. Sur une console
 * d'analytics, ce détail cosmétique envoyait à un tiers la LISTE COMPLÈTE des
 * domaines qui apparaissent dans les tableaux de bord de nos clients : leurs
 * propres sites, mais aussi tous leurs référents et tous leurs liens sortants.
 * Autrement dit, l'ossature de leur acquisition, à chaque ouverture d'une page.
 * Indéfendable pour un produit vendu « sans cookie, hébergé en France ».
 *
 * On demande donc l'icône au domaine LUI-MÊME. Aucun tiers n'apprend quoi que
 * ce soit, et la requête ne dit rien de plus que ce que la visite disait déjà.
 *
 * ⚠️ Ne JAMAIS remplacer par un service d'icônes tiers (DuckDuckGo, Google
 * s2/favicons, Clearbit…) : `scripts/check-brand.sh` échoue s'il en réapparaît.
 */

/**
 * Emplacements tentés, dans l'ordre, avant de retomber sur l'initiale.
 *
 * Un service d'icônes tiers savait résoudre n'importe quel site parce qu'il
 * avait lu son HTML. En interrogeant le domaine directement, on ne dispose que
 * des conventions — mais elles couvrent l'essentiel : `/favicon.ico` (universel),
 * `/icon.svg` (Next.js App Router, donc tous les sites qu'on livre),
 * `/favicon.png` et `/apple-touch-icon.png`.
 *
 * Vérifié sur les cinq domaines clients de la production le 2026-08-18 : quatre
 * sur cinq sont couverts. Le cinquième affiche son initiale, ce qui est le
 * repli qui existait déjà. Un site qui ajoute l'un de ces chemins retrouve son
 * icône tout seul, sans rien changer ici.
 */
export const FAVICON_PATHS = ["/favicon.ico", "/icon.svg", "/favicon.png", "/apple-touch-icon.png"] as const;

/**
 * Réduit une entrée de tableau de bord à un nom d'hôte, ou `null` si ce n'en
 * est pas un (« Direct », libellé, chaîne vide…). Les dimensions passent
 * tantôt un hôte nu, tantôt une URL complète.
 */
export function faviconHost(domain: string | null | undefined): string | null {
  if (!domain) {
    return null;
  }

  const raw = domain.trim().replace(/^https?:\/\//i, "");
  const host = raw.split("/")[0].split("?")[0].split("#")[0].split(":")[0].toLowerCase();

  // Un hôte, c'est au moins un point et rien d'autre que des caractères de nom
  // de domaine. Ce filtre écarte les libellés, sans lesquels on produirait une
  // requête vers une URL absurde.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    return null;
  }

  return host;
}

/**
 * URL de l'icône d'un domaine, servie par le domaine lui-même.
 *
 * @param attempt Rang dans `FAVICON_PATHS`. Le composant l'incrémente à chaque
 *                échec de chargement, jusqu'à épuisement.
 */
export function faviconUrl(domain: string | null | undefined, attempt = 0): string | null {
  const host = faviconHost(domain);
  const path = FAVICON_PATHS[attempt];

  if (!host || !path) {
    return null;
  }

  return `https://${host}${path}`;
}
