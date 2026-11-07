/**
 * Garde commune des routes appelées par le Hub : signature, fraîcheur, secret présent.
 * Fail-closed : rend `false` après avoir répondu, le handler s'arrête là.
 */
import { FastifyReply, FastifyRequest } from "fastify";
import { hubApiSecret, verifyHubHmac } from "../../lib/hubHmac.js";

export function allowHubRequest(req: FastifyRequest, res: FastifyReply, rawBody: string): boolean {
  const verification = verifyHubHmac(
    hubApiSecret(),
    req.headers["x-veridian-timestamp"] as string | undefined,
    rawBody,
    req.headers["x-veridian-hub-signature"] as string | undefined
  );
  if (verification.ok) {
    return true;
  }

  if (verification.reason === "missing_secret") {
    // Mal configuré, pas mal authentifié : on le dit dans les logs, jamais au client.
    req.log.error({ url: req.url }, "HUB_API_SECRET absent : appel Hub refusé");
    res.status(500).send({ error: "Server misconfigured" });
    return false;
  }
  req.log.warn({ url: req.url, reason: verification.reason }, "Appel Hub refusé");
  const error =
    verification.reason === "timestamp_drift" || verification.reason === "invalid_timestamp"
      ? "Timestamp expired or invalid"
      : "Invalid signature";
  res.status(401).send({ error });
  return false;
}
