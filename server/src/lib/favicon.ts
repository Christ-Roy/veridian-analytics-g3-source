/**
 * Icône d'un domaine — SANS tiers. Jumeau serveur de `client/src/lib/favicon.ts`.
 *
 * Amont construisait ces icônes avec `https://www.google.com/s2/favicons?domain=…`
 * dans deux surfaces qui SORTENT de l'instance :
 *   - le rapport PDF exporté par un client (le rendu va chercher l'image) ;
 *   - le rapport hebdomadaire par e-mail, où c'est la MESSAGERIE du client qui
 *     va la chercher — Google apprend alors le domaine, ses référents, et
 *     quand le client ouvre son rapport.
 *
 * On demande donc l'icône au domaine lui-même. Aucun tiers n'apprend rien.
 *
 * ⚠️ Ne JAMAIS revenir à un service d'icônes tiers : `scripts/check-brand.sh`
 * échoue s'il en réapparaît un.
 */

/**
 * Renvoie l'URL de l'icône d'un domaine, ou `undefined` si l'entrée n'est pas
 * un nom d'hôte exploitable (« Direct », libellé, chaîne vide…).
 *
 * Contrairement au jumeau client, un seul chemin est tenté : un PDF et un
 * e-mail sont figés au rendu, il n'y a pas d'`onError` pour enchaîner sur
 * `/icon.svg`. Un domaine qui ne sert pas `/favicon.ico` n'a donc pas d'icône
 * dans ces documents — l'appelant doit gérer `undefined` plutôt que produire
 * une image cassée.
 */
export function faviconUrl(domain: string | null | undefined): string | undefined {
  if (!domain) {
    return undefined;
  }

  const raw = domain.trim().replace(/^https?:\/\//i, "");
  const host = raw.split("/")[0].split("?")[0].split("#")[0].split(":")[0].toLowerCase();

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    return undefined;
  }

  return `https://${host}/favicon.ico`;
}
