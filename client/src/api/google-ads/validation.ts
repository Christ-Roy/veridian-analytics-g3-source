/**
 * Validation de l'identifiant de compte Google Ads, côté navigateur.
 *
 * 🔴 Ce n'est PAS une sécurité et ça ne remplace pas `validerCompteAds` du
 * serveur (`server/src/api/ads/settings.ts`), qui reste la seule autorité. Ça
 * existe pour une autre raison : la faute probable est un copier-coller depuis
 * l'interface Google, qui affiche le compte au format à tirets (123-456-7890).
 * Le serveur refuse ce format, à dessein — un identifiant qu'on corrige en
 * silence est un identifiant que personne ne relit, et il désigne le compte qui
 * reçoit l'argent publicitaire. Le dire AVANT la saisie évite l'aller-retour.
 *
 * Le résultat porte un MOTIF, pas un message : les textes d'interface sont
 * extraits par next-intl au point d'appel. Un validateur qui rendrait des
 * phrases toutes faites échapperait à l'extraction et resterait en anglais dans
 * toutes les langues.
 */
export type MotifCompteInvalide = "vide" | "tirets" | "non_numerique" | "longueur";

export type ResultatCompteAds =
  | { ok: true; valeur: string }
  | { ok: false; motif: MotifCompteInvalide; saisie: string; sansTirets?: string };

/**
 * 🔴 AUTORITÉ : `validerCompteAds` dans
 * `server/src/api/ads/settings.ts`. Toute règle ci-dessous en est une COPIE,
 * bornes de longueur comprises. Si les règles y changent, ce fichier ne le
 * saura pas : c'est le prix assumé pour pouvoir dire la règle AVANT la saisie
 * plutôt qu'après un aller-retour réseau. Le serveur reste seul juge, un écart
 * ne peut donc produire qu'un refus tardif, jamais une valeur acceptée à tort.
 */

/** Bornes reprises du serveur : un compte Google Ads réel fait 10 chiffres. */
export const LONGUEUR_COMPTE_MIN = 8;
export const LONGUEUR_COMPTE_MAX = 12;

export function validerCompteAds(brut: unknown): ResultatCompteAds {
  const saisie = typeof brut === "string" ? brut.trim() : "";

  if (saisie === "") {
    return { ok: false, motif: "vide", saisie };
  }

  // Le cas à tirets est nommé AVANT le cas générique : c'est la faute la plus
  // fréquente et la seule pour laquelle on peut proposer la valeur exacte à
  // coller.
  if (/^[\d-]+$/.test(saisie) && saisie.includes("-")) {
    return { ok: false, motif: "tirets", saisie, sansTirets: saisie.replace(/-/g, "") };
  }

  if (!/^\d+$/.test(saisie)) {
    return { ok: false, motif: "non_numerique", saisie };
  }

  // Un « 1 » ou un numéro de téléphone passeraient la base et n'échoueraient
  // qu'au premier envoi, en 403, plusieurs heures plus tard.
  if (saisie.length < LONGUEUR_COMPTE_MIN || saisie.length > LONGUEUR_COMPTE_MAX) {
    return { ok: false, motif: "longueur", saisie };
  }

  return { ok: true, valeur: saisie };
}
