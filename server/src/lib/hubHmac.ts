/**
 * Authentification HMAC du Veridian Hub — pattern A du contrat cross-app.
 *
 * Le Hub interroge chaque application aval avec une signature partagée plutôt
 * qu'une session : il n'y a pas d'utilisateur derrière l'appel, seulement une
 * machine qui en interroge une autre.
 *
 *     X-Veridian-Timestamp:      <unix_ms>
 *     X-Veridian-Hub-Signature:  hex(hmac_sha256(secret, "{timestamp}.{corps_brut}"))
 *
 * Pour un GET le corps est vide, donc la charge signée vaut exactement
 * `${timestamp}.` — c'est ce que produit `signGet` côté Hub
 * (`veridian-hub/lib/sync/discovery.ts`). Le chemin et la querystring
 * n'entrent PAS dans la signature : elle prouve l'identité de l'appelant et
 * la fraîcheur de l'appel, pas l'intégrité de l'URL.
 *
 * La vérification est fail-closed : tout ce qui n'est pas une signature
 * fraîche et exacte est refusé, y compris l'absence de secret côté serveur.
 */
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Fenêtre anti-rejeu. Une signature interceptée cesse d'être utilisable
 * passé ce délai ; 5 min absorbent la dérive d'horloge entre deux machines
 * sans laisser une fenêtre de rejeu exploitable.
 */
export const HUB_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

export type HubHmacFailure =
  | "missing_secret"
  | "missing_signature"
  | "invalid_timestamp"
  | "timestamp_drift"
  | "invalid_signature";

export type HubHmacResult = { ok: true } | { ok: false; reason: HubHmacFailure };

/**
 * Secret partagé avec le Hub. Lu à l'appel (et non au chargement du module)
 * pour que l'absence de configuration reste un refus explicite plutôt qu'un
 * plantage au démarrage du serveur.
 */
export function hubApiSecret(): string | undefined {
  return process.env.HUB_API_SECRET || undefined;
}

/**
 * Vérifie une signature Hub.
 *
 * @param secret    Secret partagé (`HUB_API_SECRET`).
 * @param timestamp En-tête `X-Veridian-Timestamp`, en millisecondes unix.
 * @param rawBody   Corps reçu tel quel — chaîne vide pour un GET.
 * @param signature En-tête `X-Veridian-Hub-Signature`, en hexadécimal.
 */
export function verifyHubHmac(
  secret: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
  signature: string | undefined
): HubHmacResult {
  if (!secret) {
    return { ok: false, reason: "missing_secret" };
  }
  if (!signature) {
    return { ok: false, reason: "missing_signature" };
  }
  // Un timestamp non numérique n'est pas une dérive d'horloge mais un appel
  // malformé — `Number("")` vaut 0 et passerait pour une date valide de 1970.
  if (!timestamp || !/^\d{1,15}$/.test(timestamp)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  if (Math.abs(Date.now() - Number(timestamp)) > HUB_TIMESTAMP_DRIFT_MS) {
    return { ok: false, reason: "timestamp_drift" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  // Comparaison en temps constant : une comparaison naïve laisse fuiter, par
  // son temps d'exécution, le nombre d'octets corrects en tête de signature.
  const received = Buffer.from(signature, "hex");
  const reference = Buffer.from(expected, "hex");
  if (received.length !== reference.length || !timingSafeEqual(received, reference)) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true };
}
