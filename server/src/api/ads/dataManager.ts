/**
 * Client Google Data Manager API — envoi de conversions hors ligne.
 *
 * Ce fichier ne connaît ni la base, ni les sites, ni l'attribution : il ne fait
 * que parler à Google. Tout le reste du module s'appuie dessus, ce qui le rend
 * testable sans réseau (l'appelant peut injecter `fetchImpl`).
 *
 * Pourquoi un client maison plutôt que le SDK officiel : le SDK Google Ads est
 * un paquet lourd, et il ne couvre de toute façon PAS cette API. On parle donc
 * directement au REST, avec un jeton OAuth rafraîchi par `fetch`.
 *
 * 🔴 Depuis le 15 juin 2026, l'import de conversions hors ligne est BLOQUÉ dans
 * l'API Google Ads et migré ici. Trois conséquences qui invalident tout exemple
 * antérieur à cette date, y compris ceux qui sortent en tête des recherches :
 *   - l'hôte est `datamanager.googleapis.com`, pas `googleads.googleapis.com` ;
 *   - le scope OAuth est `.../auth/datamanager`, PAS `.../auth/adwords` — un
 *     refresh_token émis avec `adwords` seul n'ouvrira jamais cette API ;
 *   - il n'y a NI en-tête `developer-token` NI `login-customer-id` ; la relation
 *     avec le compte administrateur passe par `loginAccount`, dans le corps.
 *
 * ⚠️ Ce que le code de retour ne prouve PAS (mesuré le 2026-08-29 sur le compte
 * ASD 2568911678) : un `gclid` totalement inventé reçoit un HTTP 200, et un
 * événement marqué `CONSENT_DENIED` aussi. L'API valide la FORME du message,
 * pas son contenu. Donc :
 *   - un 200 ne dit pas qu'une conversion sera comptée. Le témoin qui fait foi
 *     est la ressource GAQL `offline_conversion_upload_client_summary` ;
 *   - le respect du consentement est à NOTRE charge, en amont. S'en remettre au
 *     filtrage de Google reviendrait à exporter quand même.
 *
 * Ce que l'API rejette bien, en revanche (contrôles négatifs joués le même jour,
 * donc le vert garde du sens) : action de conversion inexistante → 404, compte
 * hors périmètre → 403, horodatage mal formé → 400, devise inconnue → 400,
 * aucun identifiant de clic → 400, valeur de consentement inventée → 400.
 */
import { createServiceLogger } from "../../lib/logger/logger.js";

const logger = createServiceLogger("ads-data-manager");

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const INGEST_URL = "https://datamanager.googleapis.com/v1/events:ingest";

/** Marge avant expiration : on rafraîchit le jeton 5 min avant l'échéance. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Identifiants OAuth. Ce sont ceux du compte administrateur, jamais ceux d'un client. */
export interface AdsCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Où atterrit la conversion : quel compte, sous quel administrateur, sur quelle action. */
export interface AdsDestination {
  /** Compte Google Ads qui reçoit la conversion, sans tirets. */
  operatingAccountId: string;
  /** Compte administrateur (MCC) par lequel nos accès sont valides, sans tirets. */
  loginAccountId?: string;
  /**
   * Id NUMÉRIQUE de l'action de conversion — pas son resource name, pas son
   * label `AW-XXXX/YYYY`. Elle doit être de type UPLOAD_CLICKS : une action
   * WEBPAGE est alimentée par le tag du site et ne peut pas recevoir d'import.
   */
  conversionActionId: string;
}

export type ConsentStatus = "CONSENT_GRANTED" | "CONSENT_DENIED" | "CONSENT_UNSPECIFIED";

export interface ConversionEvent {
  /**
   * Identifiant stable et unique de la conversion. C'est la clé de
   * déduplication de Google : renvoyer le même deux fois ne compte qu'une
   * conversion. Y mettre la clé d'idempotence de notre journal, jamais un
   * identifiant tiré au sort à l'envoi.
   */
  transactionId: string;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  /** Horodatage métier de la conversion (ISO). */
  occurredAt: string;
  value: number;
  currency: string;
  consent?: {
    adUserData: ConsentStatus;
    adPersonalization: ConsentStatus;
  };
}

/**
 * Échec d'envoi, avec la seule information dont l'outbox a besoin pour décider :
 * est-ce que réessayer a une chance de changer quelque chose ?
 *
 * Cette distinction est ce qui évite les deux travers habituels — réessayer
 * indéfiniment une configuration fausse, et abandonner à la première coupure
 * réseau.
 */
export class AdsIngestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "AdsIngestError";
  }
}

/**
 * Normalise une date ISO au format attendu par l'API (RFC 3339, UTC, sans
 * millisecondes). Une date illisible est refusée ICI plutôt qu'à Google : le
 * message d'erreur est alors exploitable, et on économise un aller-retour.
 */
export function formatEventTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new AdsIngestError(`Horodatage de conversion illisible : « ${iso} »`, false);
  }
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Extrait l'id numérique d'une action de conversion, qu'on lui passe un resource
 * name complet ou déjà l'id nu. Tolérant en entrée, strict en sortie.
 */
export function conversionActionId(resourceNameOrId: string): string {
  const m = resourceNameOrId.match(/conversionActions\/(\d+)/);
  if (m) return m[1];
  if (/^\d+$/.test(resourceNameOrId)) return resourceNameOrId;
  throw new AdsIngestError(
    `Action de conversion invalide : « ${resourceNameOrId} »`,
    false,
  );
}

/**
 * Choisit l'identifiant de clic à envoyer. L'API accepte plusieurs identifiants
 * ensemble, mais on n'en envoie qu'un : deux identifiants décrivent deux clics
 * possibles, et laisser Google arbitrer rendrait l'attribution inexplicable.
 * Priorité au `gclid`, qui est le plus précis.
 */
export function pickAdIdentifiers(event: ConversionEvent): Record<string, string> {
  if (event.gclid) return { gclid: event.gclid };
  if (event.gbraid) return { gbraid: event.gbraid };
  if (event.wbraid) return { wbraid: event.wbraid };
  throw new AdsIngestError(
    `Conversion « ${event.transactionId} » sans identifiant de clic (gclid/gbraid/wbraid).`,
    false,
  );
}

/**
 * Construit le corps de la requête. Séparé de l'envoi pour être vérifiable par
 * un test sans réseau — c'est la partie où une erreur se paie le plus cher.
 */
export function buildIngestPayload(
  destination: AdsDestination,
  events: ConversionEvent[],
  validateOnly = false,
): Record<string, unknown> {
  const dest: Record<string, unknown> = {
    operatingAccount: { accountType: "GOOGLE_ADS", accountId: destination.operatingAccountId },
    productDestinationId: conversionActionId(destination.conversionActionId),
  };
  if (destination.loginAccountId) {
    dest.loginAccount = { accountType: "GOOGLE_ADS", accountId: destination.loginAccountId };
  }

  return {
    validateOnly,
    destinations: [dest],
    events: events.map(event => ({
      destinationReferences: [],
      transactionId: event.transactionId,
      adIdentifiers: pickAdIdentifiers(event),
      conversionValue: event.value,
      currency: event.currency,
      eventTimestamp: formatEventTimestamp(event.occurredAt),
      eventSource: "WEB",
      ...(event.consent ? { consent: event.consent } : {}),
    })),
  };
}

/**
 * Un échec réseau, un 429 ou un 5xx passeront ; une configuration fausse ou un
 * message mal formé, non. Le cas du 401 mérite un mot : notre jeton est
 * rafraîchi juste avant chaque envoi, donc un 401 signale un problème d'accès
 * durable, pas une expiration à réessayer.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

type FetchLike = typeof fetch;

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * Cache mémoire du jeton d'accès, par refresh_token. Un jeton vaut une heure :
 * en redemander un à chaque conversion drainée ferait, sur un lot de cinquante,
 * cinquante appels OAuth inutiles.
 */
const tokenCache = new Map<string, CachedToken>();

/** Vide le cache. Réservé aux tests, pour qu'ils ne se contaminent pas entre eux. */
export function resetTokenCacheForTests(): void {
  tokenCache.clear();
}

export async function getAccessToken(
  credentials: AdsCredentials,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<string> {
  const cached = tokenCache.get(credentials.refreshToken);
  if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) {
    return cached.value;
  }

  let res: Response;
  try {
    res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (err) {
    throw new AdsIngestError(`OAuth injoignable : ${(err as Error).message}`, true);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Un refresh_token révoqué ou un scope absent ne se répare pas en réessayant.
    throw new AdsIngestError(
      `Rafraîchissement OAuth refusé (${res.status}) : ${body.slice(0, 300)}`,
      isRetryableStatus(res.status),
      res.status,
    );
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new AdsIngestError("Réponse OAuth sans access_token.", false);
  }
  tokenCache.set(credentials.refreshToken, {
    value: json.access_token,
    expiresAt: now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

export interface IngestOptions {
  /** Valide le message côté Google sans rien écrire dans le compte. */
  validateOnly?: boolean;
  fetchImpl?: FetchLike;
}

export interface IngestResult {
  requestId: string | null;
  eventCount: number;
  validateOnly: boolean;
}

/**
 * Envoie un lot de conversions. Toutes partagent la même destination : c'est à
 * l'appelant de grouper par action de conversion.
 *
 * Ne filtre RIEN : les règles métier (consentement refusé, mode d'essai,
 * conversion déjà envoyée) sont décidées en amont, là où elles sont visibles et
 * testables. Ce client se contente de dire à Google ce qu'on lui demande de
 * dire, et de rapporter fidèlement ce qui s'est passé.
 */
export async function ingestConversions(
  credentials: AdsCredentials,
  destination: AdsDestination,
  events: ConversionEvent[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const validateOnly = options.validateOnly ?? false;

  if (events.length === 0) {
    return { requestId: null, eventCount: 0, validateOnly };
  }

  const payload = buildIngestPayload(destination, events, validateOnly);
  const accessToken = await getAccessToken(credentials, fetchImpl);

  let res: Response;
  try {
    res = await fetchImpl(INGEST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new AdsIngestError(`Data Manager injoignable : ${(err as Error).message}`, true);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let reason: string | undefined;
    try {
      reason = (JSON.parse(body) as { error?: { status?: string } }).error?.status;
    } catch {
      // Corps non JSON : on garde le texte brut dans le message.
    }
    const retryable = isRetryableStatus(res.status);
    logger.warn(
      { status: res.status, reason, retryable, eventCount: events.length },
      "Envoi de conversions refusé par Data Manager",
    );
    throw new AdsIngestError(
      `Data Manager events:ingest ${res.status} : ${body.slice(0, 500)}`,
      retryable,
      res.status,
      reason,
    );
  }

  const json = (await res.json().catch(() => ({}))) as { requestId?: string };
  return { requestId: json.requestId ?? null, eventCount: events.length, validateOnly };
}
