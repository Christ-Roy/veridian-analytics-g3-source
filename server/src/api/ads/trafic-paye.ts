/**
 * Les visiteurs venus de la publicité, et ce qu'ils font.
 *
 * C'est la DEUXIÈME des cinq questions du ticket d'origine : « quels visiteurs,
 * comptes, commandes et abonnements viennent de ces dépenses ».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 POURQUOI IL N'Y A NI REVENU NI ROAS DANS CE FICHIER
 *
 * Les questions 3 et 4 du ticket (chiffre d'affaires attribuable, ROAS) ne sont
 * PAS oubliées : elles sont inatteignables avec les données réelles, et le
 * mesurer valait mieux que le supposer. Relevé le 2026-09-05 sur les deux seuls
 * sites du parc qui reçoivent du trafic payant, sur 30 jours :
 *
 *   site N  (site-a.fr)             N sessions, N payantes, événements
 *                                  métier : phone_click (3), email_click (2)
 *   site N (site-b.fr) N sessions, N payantes, phone_click (N)
 *
 * AUCUN de ces événements ne porte de valeur : zéro `value`, zéro `revenue`.
 * Un ROAS calculé là-dessus diviserait une dépense réelle par un revenu
 * toujours nul, et afficherait « 0 » — un nombre qui a l'air calculé et qui ne
 * mesure rien. C'est exactement la famille de défauts que ce dépôt traque.
 *
 * Ces clients sont un dépanneur et un plombier : leur conversion EST le clic sur
 * le numéro de téléphone, et elle n'a pas de montant. Le jour où un site
 * marchand enverra une valeur, la brique de coût est déjà là et le ROAS se
 * calculera. En attendant, l'écran doit dire pourquoi il ne l'affiche pas,
 * plutôt que d'afficher zéro.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 UNE SESSION EST PAYANTE, PAS UN ÉVÉNEMENT
 *
 * L'identifiant de clic n'est présent QUE sur le premier événement de la
 * session : c'est lui qui portait le paramètre d'URL. Compter les événements
 * qui portent eux-mêmes un `gclid` rend donc un chiffre trois à cinq fois trop
 * bas et parfaitement plausible — mesuré : 21 événements « payants » sur le
 * site 8 là où les sessions payantes en ont produit bien davantage.
 *
 * On qualifie donc la SESSION, puis on rattache tous ses événements.
 */
import { QuerySpec, runAnalyticsQuery } from "../analytics/utils/analyticsQuery.js";
import { normalizeDatetimeForClickhouse } from "../analytics/utils/timeWindow.js";

/**
 * Les trois identifiants de clic de Google, et pourquoi les trois.
 *
 * `gclid` est le cas courant. `gbraid` (iOS) et `wbraid` (YouTube app-to-web)
 * sont les identifiants qui le remplacent quand le suivi entre applications est
 * restreint. Ne chercher que `gclid` classerait ce trafic-là en « direct »,
 * c'est-à-dire attribuerait à l'organique des visites payées.
 */
export const PARAMETRES_CLIC = ["gclid", "gbraid", "wbraid"] as const;

/**
 * Événements techniques, exclus du décompte des actions.
 *
 * `web-vitals` est émis automatiquement par le traceur à chaque page : il
 * représente 95 % des événements nommés et n'est l'action de personne. Le
 * compter ferait afficher « 98 actions » pour trois appels téléphoniques.
 */
export const EVENEMENTS_TECHNIQUES = ["web-vitals", "Error", "TypeError"] as const;

export interface TraficPaye {
  sessionsTotal: number;
  sessionsPayantes: number;
  visiteursPayants: number;
  /** Actions métier des sessions payantes, par nom, décroissant. */
  actions: Array<{ nom: string; sessions: number; total: number }>;
}

/**
 * La requête. Fonction PURE, donc éprouvable sans ClickHouse — et c'est ce qui
 * compte : une faute ici ne lève pas, elle rend un chiffre plus petit.
 */
export function construireRequeteTraficPaye(siteId: number, debut: string, fin: string): QuerySpec {
  const query = `
    WITH sessions_payantes AS (
        SELECT DISTINCT session_id
        FROM events
        WHERE site_id = {siteId:UInt16}
          AND timestamp >= toDateTime({debut:String}, 'UTC')
          AND timestamp <= toDateTime({fin:String}, 'UTC')
          AND arrayExists(p -> mapContains(url_parameters, p), {parametres:Array(String)})
    )
    SELECT
        (SELECT uniqExact(session_id) FROM events
          WHERE site_id = {siteId:UInt16}
            AND timestamp >= toDateTime({debut:String}, 'UTC')
            AND timestamp <= toDateTime({fin:String}, 'UTC')) AS sessionsTotal,
        (SELECT count() FROM sessions_payantes) AS sessionsPayantes,
        (SELECT uniqExact(user_id) FROM events
          WHERE site_id = {siteId:UInt16}
            AND timestamp >= toDateTime({debut:String}, 'UTC')
            AND timestamp <= toDateTime({fin:String}, 'UTC')
            AND session_id IN (SELECT session_id FROM sessions_payantes)) AS visiteursPayants
  `;
  return {
    query,
    params: {
      siteId,
      debut: normalizeDatetimeForClickhouse(`${debut}T00:00:00.000Z`),
      fin: normalizeDatetimeForClickhouse(`${fin}T23:59:59.999Z`),
      parametres: [...PARAMETRES_CLIC],
    },
  };
}

/** Les actions métier des sessions payantes. Requête séparée : elle rend N lignes. */
export function construireRequeteActionsPayantes(siteId: number, debut: string, fin: string): QuerySpec {
  const query = `
    WITH sessions_payantes AS (
        SELECT DISTINCT session_id
        FROM events
        WHERE site_id = {siteId:UInt16}
          AND timestamp >= toDateTime({debut:String}, 'UTC')
          AND timestamp <= toDateTime({fin:String}, 'UTC')
          AND arrayExists(p -> mapContains(url_parameters, p), {parametres:Array(String)})
    )
    SELECT
        event_name AS nom,
        uniqExact(session_id) AS sessions,
        count() AS total
    FROM events
    WHERE site_id = {siteId:UInt16}
      AND timestamp >= toDateTime({debut:String}, 'UTC')
      AND timestamp <= toDateTime({fin:String}, 'UTC')
      AND event_name != ''
      AND event_name NOT IN ({techniques:Array(String)})
      AND session_id IN (SELECT session_id FROM sessions_payantes)
    GROUP BY event_name
    ORDER BY total DESC
    LIMIT 50
  `;
  return {
    query,
    params: {
      siteId,
      debut: normalizeDatetimeForClickhouse(`${debut}T00:00:00.000Z`),
      fin: normalizeDatetimeForClickhouse(`${fin}T23:59:59.999Z`),
      parametres: [...PARAMETRES_CLIC],
      techniques: [...EVENEMENTS_TECHNIQUES],
    },
  };
}

export interface DependancesTraficPaye {
  executer?: <T>(spec: QuerySpec) => Promise<T[]>;
}

export async function lireTraficPaye(
  siteId: number,
  debut: string,
  fin: string,
  deps: DependancesTraficPaye = {}
): Promise<TraficPaye> {
  const executer = deps.executer ?? (<T,>(spec: QuerySpec) => runAnalyticsQuery<T>(spec));

  const [totaux, actions] = await Promise.all([
    executer<{ sessionsTotal: string | number; sessionsPayantes: string | number; visiteursPayants: string | number }>(
      construireRequeteTraficPaye(siteId, debut, fin)
    ),
    executer<{ nom: string; sessions: string | number; total: string | number }>(
      construireRequeteActionsPayantes(siteId, debut, fin)
    ),
  ]);

  // ClickHouse rend ses agrégats en CHAÎNES pour les grands entiers. Les laisser
  // tels quels ferait faire des concaténations là où on attend des additions,
  // sans qu'aucune erreur ne le signale.
  const t = totaux[0] ?? { sessionsTotal: 0, sessionsPayantes: 0, visiteursPayants: 0 };
  return {
    sessionsTotal: Number(t.sessionsTotal ?? 0),
    sessionsPayantes: Number(t.sessionsPayantes ?? 0),
    visiteursPayants: Number(t.visiteursPayants ?? 0),
    actions: actions.map(a => ({ nom: a.nom, sessions: Number(a.sessions), total: Number(a.total) })),
  };
}
