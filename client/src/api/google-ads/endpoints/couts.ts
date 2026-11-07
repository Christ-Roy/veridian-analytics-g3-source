import { authedFetch } from "../../utils";

/**
 * Dépenses publicitaires d'un site sur une période
 * (`server/src/api/ads/routes.ts` → `getAdsCouts`).
 *
 * 🔴 `totaux` EST UN TABLEAU, UN PAR DEVISE, et jamais un nombre. Un compte
 * Google Ads a sa devise, un client peut en changer, et additionner des euros
 * et des dollars donnerait un chiffre parfaitement plausible et parfaitement
 * faux. Le type l'interdit à l'écran ; ne pas l'aplatir « pour simplifier ».
 *
 * `costMicros` est en MILLIONIÈMES d'unité monétaire, l'unité que rend Google.
 * La conversion se fait à l'affichage, une seule fois, et jamais en base :
 * convertir plus tôt ferait diverger nos chiffres des rapports Google sans que
 * rien ne le signale.
 */
export type AdsCoutTotal = {
  currency: string;
  costMicros: number;
  clicks: number;
  impressions: number;
};

export type AdsCoutCampagne = AdsCoutTotal & {
  campaignId: string;
  campaignName: string;
  conversions: number;
  conversionsValue: number;
};

/**
 * Le trafic acheté par cette dépense.
 *
 * 🔴 `null` N'EST PAS ZÉRO. Il veut dire « la lecture a échoué », pas « aucun
 * visiteur n'est venu » : la dépense vient de Postgres et le trafic de
 * ClickHouse, donc l'un peut répondre sans l'autre. Les confondre ferait
 * afficher « 0 visiteur venu de la publicité » un jour de panne, c'est-à-dire
 * la pire des conclusions possibles au pire moment.
 */
export type AdsTraficPaye = {
  sessionsTotal: number;
  sessionsPayantes: number;
  visiteursPayants: number;
  actions: Array<{ nom: string; sessions: number; total: number }>;
};

export type AdsCouts = {
  debut: string;
  fin: string;
  totaux: AdsCoutTotal[];
  campagnes: AdsCoutCampagne[];
  trafic: AdsTraficPaye | null;
};

export async function fetchAdsCouts(site: number | string, debut: string, fin: string): Promise<AdsCouts> {
  return authedFetch<AdsCouts>(`/sites/${site}/ads/couts`, { start_date: debut, end_date: fin });
}
