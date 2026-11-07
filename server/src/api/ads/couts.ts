/**
 * Import des DÉPENSES publicitaires depuis Google Ads.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 CE FICHIER PARLE À UNE AUTRE API QUE `dataManager.ts`. NE PAS LES CONFONDRE.
 *
 * `dataManager.ts` ENVOIE des conversions, et depuis le 15 juin 2026 cela passe
 * par `datamanager.googleapis.com`, sans `developer-token`, avec le scope
 * `.../auth/datamanager`.
 *
 * Ce fichier-ci LIT des rapports, ce qui reste l'API Google Ads classique :
 *   - hôte `googleads.googleapis.com`, chemin `googleAds:searchStream` ;
 *   - en-têtes `developer-token` ET `login-customer-id` OBLIGATOIRES, alors que
 *     l'autre API les refuse ;
 *   - scope `.../auth/adwords`.
 * Vérifié le 2026-09-04 : le jeton de rafraîchissement du compte administrateur
 * porte les deux scopes, donc un seul jeu d'identifiants suffit. Si un jour la
 * lecture rend 403 alors que l'envoi marche, c'est le scope qu'il faut regarder,
 * pas les droits sur le compte.
 *
 * ⚠️ LA VERSION DE L'API EST DANS L'URL, et elle périme. `v21` rend un 404 HTML
 * (pas un JSON d'erreur), ce qui casse tout analyseur qui suppose du JSON.
 * `v23` au 2026-09-04.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POURQUOI IMPORTER PLUSIEURS JOURS À CHAQUE PASSAGE
 *
 * Google RÉVISE ses chiffres après coup : clics invalides retirés, conversions
 * attribuées en retard, parfois plusieurs jours plus tard. Un import qui ne
 * prendrait que la veille figerait des valeurs fausses, et personne ne le
 * verrait puisqu'elles auraient l'air complètes. On réimporte donc une fenêtre
 * glissante et on écrase, ce que la clé primaire (site, date, campagne) rend
 * possible sans dupliquer.
 */
import cluster from "node:cluster";
import * as cron from "node-cron";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db/postgres/postgres.js";
import { adsCostDaily, adsSiteSettings } from "../../db/postgres/schema.js";
import { createServiceLogger } from "../../lib/logger/logger.js";

const logger = createServiceLogger("ads-couts");

/** Ce que rend `cron.schedule`. Nommé pour que le planificateur soit injectable. */
type NodeCronTask = { stop: () => void };
/** Injectable : les tests prouvent la planification sans attendre une heure. */
export type PlanificateurCron = (
  expression: string,
  action: () => void | Promise<void>,
  options?: { timezone?: string }
) => NodeCronTask;

const URL_OAUTH = "https://oauth2.googleapis.com/token";
const HOTE_ADS = "https://googleads.googleapis.com";
const VERSION_API = "v23";

/** Fenêtre réimportée à chaque passage, en jours. Cf. l'en-tête : Google révise. */
export const FENETRE_REVISION_JOURS = 14;

export interface IdentifiantsAds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Compte administrateur (MCC), en en-tête `login-customer-id`. */
  loginCustomerId: string;
  developerToken: string;
}

export interface LigneCout {
  date: string;
  campaignId: string;
  campaignName: string;
  currency: string;
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionsValue: number;
}

export class AdsCoutsError extends Error {
  constructor(
    message: string,
    /** `true` quand réessayer plus tard a un sens (réseau, 5xx, quota). */
    readonly reessayable: boolean,
    readonly statut?: number
  ) {
    super(message);
    this.name = "AdsCoutsError";
  }
}

/**
 * Identifiants lus dans la configuration serveur. Ce sont ceux du compte
 * ADMINISTRATEUR, jamais ceux d'un client : nos comptes clients vivent sous le
 * MCC Veridian, et un site ne porte que « quel compte Ads ».
 */
export function identifiantsDepuisEnv(env: NodeJS.ProcessEnv = process.env): IdentifiantsAds | null {
  const clientId = env.GOOGLE_ADS_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_ADS_OAUTH_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN;
  const loginCustomerId = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  const developerToken = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!clientId || !clientSecret || !refreshToken || !loginCustomerId || !developerToken) return null;
  return { clientId, clientSecret, refreshToken, loginCustomerId, developerToken };
}

/** `YYYY-MM-DD` en UTC. Google veut ce format et refuse tout autre. */
export function jourUtc(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * La requête GAQL. Fonction PURE, donc testable sans réseau — et c'est ce qui
 * compte, parce que les fautes de cette requête (nom de champ, segment manquant)
 * se paient en 400 opaques.
 *
 * `segments.date` est à la fois SÉLECTIONNÉ et filtré : sans la sélection,
 * l'API agrège tout sur la période et rend UNE ligne par campagne, sans date.
 * L'import écrirait alors toute la période sur un seul jour, ce qui ressemble à
 * des données valides.
 */
export function construireRequeteCouts(debut: string, fin: string): string {
  return [
    "SELECT",
    "campaign.id,",
    "campaign.name,",
    "customer.currency_code,",
    "segments.date,",
    "metrics.cost_micros,",
    "metrics.impressions,",
    "metrics.clicks,",
    "metrics.conversions,",
    "metrics.conversions_value",
    "FROM campaign",
    `WHERE segments.date BETWEEN '${debut}' AND '${fin}'`,
  ].join(" ");
}

/** Un jeton d'accès, échangé contre le jeton de rafraîchissement. */
async function jetonAcces(ids: IdentifiantsAds, fetchImpl: typeof fetch): Promise<string> {
  const corps = new URLSearchParams({
    client_id: ids.clientId,
    client_secret: ids.clientSecret,
    refresh_token: ids.refreshToken,
    grant_type: "refresh_token",
  });
  let reponse: Response;
  try {
    reponse = await fetchImpl(URL_OAUTH, { method: "POST", body: corps });
  } catch (erreur) {
    throw new AdsCoutsError(`OAuth injoignable : ${(erreur as Error).message}`, true);
  }
  if (!reponse.ok) {
    // 4xx sur OAuth = identifiants faux ou révoqués : réessayer n'y changera rien.
    throw new AdsCoutsError(`OAuth refusé (HTTP ${reponse.status})`, reponse.status >= 500, reponse.status);
  }
  const json = (await reponse.json()) as { access_token?: string };
  if (!json.access_token) throw new AdsCoutsError("OAuth a répondu sans jeton d'accès", false);
  return json.access_token;
}

/**
 * Lit les coûts d'un compte sur une période.
 *
 * `fetchImpl` est injectable : les tests prouvent l'analyse de la réponse sans
 * réseau, et la preuve réseau réelle vit à part, derrière un drapeau.
 */
export async function lireCoutsCampagnes(
  compteClient: string,
  debut: string,
  fin: string,
  ids: IdentifiantsAds,
  fetchImpl: typeof fetch = fetch
): Promise<LigneCout[]> {
  const jeton = await jetonAcces(ids, fetchImpl);
  const url = `${HOTE_ADS}/${VERSION_API}/customers/${compteClient}/googleAds:searchStream`;

  let reponse: Response;
  try {
    reponse = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jeton}`,
        "developer-token": ids.developerToken,
        "login-customer-id": ids.loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: construireRequeteCouts(debut, fin) }),
    });
  } catch (erreur) {
    throw new AdsCoutsError(`API Ads injoignable : ${(erreur as Error).message}`, true);
  }

  if (!reponse.ok) {
    const texte = (await reponse.text()).slice(0, 300);
    // 404 = version d'API périmée (et Google rend du HTML, pas du JSON).
    // 403 = scope ou périmètre. 429/5xx = réessayable.
    const reessayable = reponse.status === 429 || reponse.status >= 500;
    throw new AdsCoutsError(`API Ads a refusé (HTTP ${reponse.status}) : ${texte}`, reessayable, reponse.status);
  }

  let charge: unknown;
  try {
    charge = await reponse.json();
  } catch {
    throw new AdsCoutsError("API Ads a répondu autre chose que du JSON", false);
  }

  // `searchStream` rend un TABLEAU de lots, pas un objet. Le confondre avec la
  // forme de `search` fait lire zéro ligne sans la moindre erreur.
  if (!Array.isArray(charge)) {
    throw new AdsCoutsError("réponse inattendue : searchStream doit rendre un tableau de lots", false);
  }

  const lignes: LigneCout[] = [];
  for (const lot of charge as Array<{ results?: unknown[] }>) {
    for (const brut of lot.results ?? []) {
      const r = brut as {
        campaign?: { id?: string | number; name?: string };
        customer?: { currencyCode?: string };
        segments?: { date?: string };
        metrics?: Record<string, string | number>;
      };
      const date = r.segments?.date;
      const campaignId = r.campaign?.id;
      // Une ligne sans date ou sans campagne est inexploitable : l'écrire
      // fabriquerait une clé primaire fausse. On la nomme plutôt que de la
      // laisser passer en silence.
      if (!date || campaignId === undefined || campaignId === null) {
        logger.warn({ ligne: r }, "Ligne de coût sans date ou sans campagne, ignorée");
        continue;
      }
      const m = r.metrics ?? {};
      lignes.push({
        date,
        campaignId: String(campaignId),
        campaignName: r.campaign?.name ?? "",
        currency: r.customer?.currencyCode ?? "EUR",
        costMicros: Number(m.costMicros ?? 0),
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        conversions: Number(m.conversions ?? 0),
        conversionsValue: Number(m.conversionsValue ?? 0),
      });
    }
  }
  return lignes;
}

/**
 * Écrit les lignes lues, en ÉCRASANT celles qui existent déjà.
 *
 * L'écrasement n'est pas une commodité : Google révise ses chiffres après coup,
 * donc réimporter une période DOIT remplacer ce qu'on avait. Un `ON CONFLICT DO
 * NOTHING` figerait la première valeur vue, qui est justement la moins juste.
 */
export async function enregistrerCouts(
  siteId: number,
  customerId: string,
  lignes: LigneCout[],
  base = db
): Promise<number> {
  if (lignes.length === 0) return 0;
  await base
    .insert(adsCostDaily)
    .values(
      lignes.map(l => ({
        siteId,
        customerId,
        date: l.date,
        campaignId: l.campaignId,
        campaignName: l.campaignName,
        currency: l.currency,
        costMicros: l.costMicros,
        impressions: l.impressions,
        clicks: l.clicks,
        conversions: String(l.conversions),
        conversionsValue: String(l.conversionsValue),
      }))
    )
    .onConflictDoUpdate({
      target: [adsCostDaily.siteId, adsCostDaily.date, adsCostDaily.campaignId],
      set: {
        campaignName: sql`excluded.campaign_name`,
        currency: sql`excluded.currency`,
        costMicros: sql`excluded.cost_micros`,
        impressions: sql`excluded.impressions`,
        clicks: sql`excluded.clicks`,
        conversions: sql`excluded.conversions`,
        conversionsValue: sql`excluded.conversions_value`,
        importedAt: sql`now()`,
      },
    });
  return lignes.length;
}

/** Les sites qui ont déclaré un compte Ads. L'import ne devine aucun rattachement. */
export async function sitesAvecCompteAds(base = db): Promise<Array<{ siteId: number; customerId: string }>> {
  const lignes = await base
    .select({ siteId: adsSiteSettings.siteId, customerId: adsSiteSettings.customerId })
    .from(adsSiteSettings);
  return lignes;
}

/**
 * Total dépensé sur une période, pour un site.
 *
 * ⚠️ REND UN TOTAL PAR DEVISE, et pas un nombre. Additionner des euros et des
 * dollars donnerait un chiffre qui a l'air juste et ne veut rien dire ; le type
 * de retour interdit de le faire par accident.
 */
export async function totalDepense(
  siteId: number,
  debut: string,
  fin: string,
  base = db
): Promise<Array<{ currency: string; costMicros: number; clicks: number; impressions: number }>> {
  const lignes = await base
    .select({
      currency: adsCostDaily.currency,
      costMicros: sql<number>`sum(${adsCostDaily.costMicros})::bigint`,
      clicks: sql<number>`sum(${adsCostDaily.clicks})::bigint`,
      impressions: sql<number>`sum(${adsCostDaily.impressions})::bigint`,
    })
    .from(adsCostDaily)
    .where(and(eq(adsCostDaily.siteId, siteId), gte(adsCostDaily.date, debut), lte(adsCostDaily.date, fin)))
    .groupBy(adsCostDaily.currency);
  return lignes.map(l => ({
    currency: l.currency,
    costMicros: Number(l.costMicros),
    clicks: Number(l.clicks),
    impressions: Number(l.impressions),
  }));
}

/**
 * Détail par campagne sur une période.
 *
 * Sert la question « où part l'argent », que le total seul ne peut pas
 * répondre : un client qui voit 300 € dépensés sans savoir sur quelle campagne
 * n'apprend rien d'actionnable.
 *
 * Trié par coût décroissant : la première ligne est celle sur laquelle une
 * décision se prend.
 */
export async function detailDepense(
  siteId: number,
  debut: string,
  fin: string,
  base = db
): Promise<
  Array<{
    campaignId: string;
    campaignName: string;
    currency: string;
    costMicros: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversionsValue: number;
  }>
> {
  const lignes = await base
    .select({
      campaignId: adsCostDaily.campaignId,
      // Le nom peut changer dans le temps ; on prend le plus récent connu,
      // sinon une campagne renommée apparaîtrait deux fois sous deux noms.
      campaignName: sql<string>`(array_agg(${adsCostDaily.campaignName} ORDER BY ${adsCostDaily.date} DESC))[1]`,
      currency: adsCostDaily.currency,
      costMicros: sql<number>`sum(${adsCostDaily.costMicros})::bigint`,
      clicks: sql<number>`sum(${adsCostDaily.clicks})::bigint`,
      impressions: sql<number>`sum(${adsCostDaily.impressions})::bigint`,
      conversions: sql<number>`sum(${adsCostDaily.conversions})`,
      conversionsValue: sql<number>`sum(${adsCostDaily.conversionsValue})`,
    })
    .from(adsCostDaily)
    .where(and(eq(adsCostDaily.siteId, siteId), gte(adsCostDaily.date, debut), lte(adsCostDaily.date, fin)))
    .groupBy(adsCostDaily.campaignId, adsCostDaily.currency)
    .orderBy(sql`sum(${adsCostDaily.costMicros}) DESC`);

  return lignes.map(l => ({
    campaignId: l.campaignId,
    campaignName: l.campaignName,
    currency: l.currency,
    costMicros: Number(l.costMicros),
    clicks: Number(l.clicks),
    impressions: Number(l.impressions),
    conversions: Number(l.conversions),
    conversionsValue: Number(l.conversionsValue),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// L'IMPORT PLANIFIÉ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Une fois par heure, et non une fois par jour.
 *
 * Un import quotidien à heure fixe a un défaut qu'on ne voit pas venir : le jour
 * où il échoue (quota, panne réseau, nœud qui redémarre), les chiffres restent
 * périmés vingt-quatre heures, et rien ne le dit puisque la table contient des
 * données d'hier parfaitement plausibles. Une cadence horaire fait de chaque
 * incident un retard d'une heure au lieu d'un jour, et rend le rattrapage
 * automatique au lieu de dépendre de quelqu'un qui s'en aperçoit.
 *
 * Le coût est nul : la fenêtre relue est la même, l'écriture est idempotente, et
 * l'API Ads ne facture pas la lecture. À 17 minutes de l'heure, pas à l'heure
 * ronde : rien d'autre n'a de raison de se réveiller à ce moment-là.
 */
export const CADENCE_IMPORT_COUTS = "17 * * * *";

export interface BilanImportCouts {
  sites: number;
  lignes: number;
  erreurs: number;
  /** Sites dont l'import a échoué, avec la raison. Vide n'est pas « rien à dire ». */
  echecs: Array<{ siteId: number; message: string; reessayable: boolean }>;
}

/**
 * Importe les dépenses de tous les sites ayant déclaré un compte Ads.
 *
 * ⚠️ UN SITE EN ÉCHEC N'ARRÊTE PAS LES AUTRES. Un compte révoqué, un quota
 * dépassé ou un identifiant erroné sur UN site ne doit pas priver les autres de
 * leurs chiffres. Les échecs sont collectés et rendus, pas levés.
 */
export async function importerCouts(
  options: {
    ids?: IdentifiantsAds | null;
    fetchImpl?: typeof fetch;
    maintenant?: Date;
    base?: typeof db;
  } = {}
): Promise<BilanImportCouts> {
  const ids = options.ids ?? identifiantsDepuisEnv();
  const base = options.base ?? db;
  const bilan: BilanImportCouts = { sites: 0, lignes: 0, erreurs: 0, echecs: [] };

  if (!ids) {
    // Même choix que le drain : on NOMME l'absence au lieu de rendre un bilan
    // vide, qui se lirait comme « aucun site à importer ».
    throw new AdsCoutsError("identifiants Google Ads absents de la configuration serveur", false);
  }

  const sites = await sitesAvecCompteAds(base);
  if (sites.length === 0) return bilan;

  const maintenant = options.maintenant ?? new Date();
  // La veille comme borne haute : le jour en cours est partiel chez Google, et
  // l'importer ferait afficher une dépense qui baisse d'heure en heure.
  const fin = jourUtc(new Date(maintenant.getTime() - 86_400_000));
  const debut = jourUtc(new Date(maintenant.getTime() - (FENETRE_REVISION_JOURS + 1) * 86_400_000));

  for (const site of sites) {
    bilan.sites += 1;
    try {
      const lignes = await lireCoutsCampagnes(site.customerId, debut, fin, ids, options.fetchImpl ?? fetch);
      bilan.lignes += await enregistrerCouts(site.siteId, site.customerId, lignes, base);
    } catch (erreur) {
      bilan.erreurs += 1;
      const e = erreur as AdsCoutsError;
      bilan.echecs.push({
        siteId: site.siteId,
        message: e.message,
        reessayable: e.reessayable ?? true,
      });
      logger.error({ siteId: site.siteId, err: e.message }, "Import des coûts Ads en échec pour ce site");
    }
  }
  return bilan;
}

class AdsCoutsService {
  private tache: NodeCronTask | null = null;
  private journal = createServiceLogger("ads-couts-cron");
  /** Empêche deux passages de se chevaucher DANS le même processus. */
  private enCours = false;

  private initialiser(planifier: PlanificateurCron) {
    // 🔴 Le même garde que le balayage et le drain, et pour la même raison :
    // avec plusieurs workers, chacun importerait les mêmes journées. Rien ne
    // serait compté deux fois (l'écriture est idempotente), mais on paierait
    // autant d'appels à l'API Google que de workers, sans qu'aucune erreur ne
    // le signale — jusqu'au jour où le quota mord.
    //
    // ⚠️ Ce garde NE SUFFIT PAS SEUL, et c'est la leçon du 2026-09-03 : les
    // deux crons du module vivaient derrière `if (!cluster.isWorker)` dans
    // `index.ts`, or en mode cluster le primaire n'importe jamais ce fichier.
    // Ils n'étaient démarrés NULLE PART. Le démarrage doit être appelé depuis
    // `cluster.ts` pour le primaire ET depuis `index.ts` pour le mode
    // mono-processus ; `balayage.orphelins.test.ts` exige les deux.
    if (cluster.isWorker) {
      this.journal.debug("Import des coûts Ads non planifié sur un worker de cluster");
      return;
    }

    this.tache = planifier(
      CADENCE_IMPORT_COUTS,
      async () => {
        if (this.enCours) {
          this.journal.warn("Passage d'import des coûts sauté : le précédent n'est pas terminé");
          return;
        }
        this.enCours = true;
        try {
          const bilan = await importerCouts();
          if (bilan.sites > 0) this.journal.info(bilan, "Import des coûts Ads terminé");
        } catch (error) {
          this.journal.error(error as Error, "Erreur pendant l'import des coûts Ads");
        } finally {
          this.enCours = false;
        }
      },
      { timezone: "UTC" }
    );

    this.journal.info(`Import des coûts Ads planifié (${CADENCE_IMPORT_COUTS})`);
  }

  public startAdsCostCron(planifier: PlanificateurCron = cron.schedule) {
    this.initialiser(planifier);
  }

  public stopAdsCostCron() {
    if (this.tache) {
      this.tache.stop();
      this.tache = null;
      this.journal.info("Import des coûts Ads arrêté");
    }
  }

  /** Un passage immédiat, pour les diagnostics et les tests de bout en bout. */
  public async importerMaintenant(options?: Parameters<typeof importerCouts>[0]): Promise<BilanImportCouts> {
    return importerCouts(options);
  }
}

export const adsCoutsService = new AdsCoutsService();
