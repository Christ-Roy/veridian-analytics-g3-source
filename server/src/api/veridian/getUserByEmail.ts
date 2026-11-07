/**
 * GET /api/users/by-email?email=<email>
 *
 * Découverte Hub. À chaque connexion, le Veridian Hub demande à chaque
 * application aval « cet utilisateur a-t-il quelque chose chez toi ? » et
 * construit son tableau de bord avec les réponses. C'est ce qui remplace une
 * table de tenants dénormalisée côté Hub : la vérité reste ici.
 *
 * Authentification : HMAC Hub, sans session (cf `lib/hubHmac.ts`). Fail-closed.
 *
 * Réponses :
 *   200 { found: true, user_email, workspaces: [...] }
 *   404 { found: false }                     utilisateur inconnu ou sans site
 *   400 { error: "missing_email" | "invalid_email" }
 *   401 { error: ... }                       signature absente, fausse ou périmée
 */
import { FastifyReply, FastifyRequest } from "fastify";
import { allowHubRequest } from "./hubAuth.js";
import { findAccountWorkspaces, isValidEmail } from "./workspaces.js";

export async function getUserByEmail(req: FastifyRequest<{ Querystring: { email?: string } }>, res: FastifyReply) {
  // ─── Authentification ────────────────────────────────────────────────────
  // GET : pas de corps, le Hub signe `${timestamp}.`
  if (!allowHubRequest(req, res, "")) {
    return;
  }

  // ─── Validation ──────────────────────────────────────────────────────────
  const email = req.query.email?.trim().toLowerCase();
  if (!email) {
    return res.status(400).send({ error: "missing_email" });
  }
  if (!isValidEmail(email)) {
    return res.status(400).send({ error: "invalid_email" });
  }

  try {
    const found = await findAccountWorkspaces(email);
    if (!found) {
      return res.status(404).send({ found: false });
    }

    return res.status(200).send({
      found: true,
      user_email: found.account.email,
      workspaces: found.workspaces,
    });
  } catch (err) {
    req.log.error({ err }, "Erreur dans getUserByEmail");
    return res.status(500).send({ error: "Internal error" });
  }
}
