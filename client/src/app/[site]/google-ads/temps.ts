/**
 * Le temps, tel que les écrans Google Ads doivent le lire et l'afficher.
 *
 * Ce fichier existe pour la même raison que `montant.ts` : trois surfaces
 * parlent de la même file d'envoi (la page `/google-ads`, la carte du tableau
 * de bord, le gestionnaire de réglages). Chaque règle recopiée dans l'une des
 * trois finit par diverger, et une divergence sur CE sujet-là ne se voit pas :
 * elle produit une alerte qui manque, ou une alerte qui ment.
 */

import { DateTime } from "luxon";

/**
 * Retard toléré sur l'échéance d'envoi, en secondes.
 *
 * 🔴 L'indicateur n'est PAS l'âge de la ligne : le report entre deux tentatives
 * est exponentiel sur 6 essais, soit plus de douze heures d'attente parfaitement
 * légitimes. C'est l'ÉCHÉANCE DÉPASSÉE qui parle : le drain passe toutes les
 * 2 minutes, donc une échéance en retard d'un quart d'heure ne veut dire qu'une
 * chose, le drain ne tourne pas. Ça ne dépend ni du trafic du site ni du rang de
 * la tentative, et ça ne produit aucun faux positif.
 *
 * `oldestOverdueBy` exclut déjà les états terminaux côté serveur : leur échéance
 * est figée dans le passé pour toujours, et les compter ferait hurler l'alerte à
 * vie sur un site sain.
 *
 * 🔴 Ce seuil décide qu'un envoi est mort. Il n'a qu'une seule définition, ici :
 * une seconde copie ailleurs divergerait au premier ajustement, et l'écran resté
 * en arrière se tairait pendant que les autres alertent.
 */
export const SECONDES_DE_RETARD_TOLEREES = 15 * 60;

/**
 * Le drain a-t-il cessé de tourner ? `retard` est `AdsHealth.oldestOverdueBy` :
 * `null` quand aucune échéance n'est dépassée.
 */
export function envoiArrete(retard: number | null | undefined): retard is number {
  return typeof retard === "number" && retard >= SECONDES_DE_RETARD_TOLEREES;
}

/** Un retard en secondes, rendu lisible : « 18 min », « 3 h ». */
export function dureeCourte(secondes: number): string {
  if (secondes < 90 * 60) return `${Math.round(secondes / 60)} min`;
  return `${Math.round(secondes / 3600)} h`;
}

/**
 * Un horodatage ISO rendu en « il y a 3 heures », ou `null` si la date est
 * absente ou illisible.
 *
 * Aucun écran ne montre l'ISO brut au client : « 2026-08-29T10:00:00.000Z » ne
 * répond pas à la seule question qu'on se pose devant une file, « est-ce que
 * c'est vieux ». L'appelant décide quoi faire du `null` — la page se contente
 * d'omettre la note, le gestionnaire retombe sur la valeur brute plutôt que de
 * n'afficher rien du tout.
 */
export function relatif(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const dt = DateTime.fromISO(iso);
  return dt.isValid ? dt.toRelative() : null;
}
