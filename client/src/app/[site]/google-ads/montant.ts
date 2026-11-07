/**
 * Formatage d'un montant de conversion.
 *
 * Il n'existe aucun helper de montant dans le dépôt (`lib/utils` ne porte qu'un
 * `formatter` compact, sans devise), d'où ce fichier plutôt qu'un
 * `Intl.NumberFormat` recopié dans chaque composant.
 *
 * 🔴 Deux raisons de ne PAS appeler `Intl.NumberFormat` directement :
 *
 * 1. Un code devise invalide fait LEVER `Intl.NumberFormat` (RangeError). La
 *    devise vient de la base, saisie par le client dans le formulaire de
 *    correspondance : une valeur bancale ferait tomber tout l'écran au rendu,
 *    et rien dans la pile ne désignerait la ligne fautive.
 * 2. `defaultValue` est une CHAÎNE côté API (colonne `numeric(14,2)`), donc
 *    `null`, `""` et `"0.00"` arrivent tous ici et ne veulent PAS dire la même
 *    chose : absence de valeur d'un côté, valeur nulle explicite de l'autre.
 */

/** Rendu d'une valeur absente, distinct d'un zéro. */
export const AUCUN_MONTANT = "—";

export function formaterMontant(valeur: string | number | null | undefined, devise: string | null | undefined): string {
  if (valeur === null || valeur === undefined || valeur === "") return AUCUN_MONTANT;

  const nombre = typeof valeur === "number" ? valeur : Number(valeur);
  if (!Number.isFinite(nombre)) return AUCUN_MONTANT;

  const code = (devise || "EUR").toUpperCase();

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(nombre);
  } catch {
    // Devise inexploitable : on rend le nombre et le code tels quels plutôt que
    // de laisser l'exception emporter l'écran.
    return `${nombre.toFixed(2)} ${code}`;
  }
}

/**
 * Vrai quand la correspondance partira sans montant. Ce n'est pas une erreur en
 * soi (un formulaire de contact n'a pas de prix), mais c'est ce qui alimente
 * `zeroValueSent` et fausse le retour sur investissement du compte, sans
 * qu'aucune erreur ne soit jamais levée.
 */
export function estSansMontant(valeur: string | number | null | undefined): boolean {
  if (valeur === null || valeur === undefined || valeur === "") return true;
  const nombre = typeof valeur === "number" ? valeur : Number(valeur);
  return !Number.isFinite(nombre) || nombre === 0;
}
