/**
 * Le Hub est la seule source de vérité des utilisateurs (CONTRAT-HUB §3.8) : la table
 * `user` n'en est qu'une copie, que ces deux routes permettent de comparer et d'alimenter.
 *
 *   GET  /api/hub/users        { users: [{ hub_user_id, email, name }] }
 *   POST /api/hub/users/sync   { hub_user_id, name?, email?, deleted?, revoke_sessions? }
 *     200 { updated: true | false }      idempotent : false quand il n'y avait rien à changer
 *     404 { error: "user_not_in_app" }   aucun compte lié à ce hub_user_id
 *     409 { error: "email_conflict" }    l'adresse appartient à un autre compte
 *     400 { error: "invalid_payload" }
 *
 * `sync` retrouve le compte par `hub_user_id` uniquement, jamais par email : changer son
 * adresse au Hub ne doit pas pouvoir atteindre le compte d'un autre.
 *
 * `deleted: true` ne supprime aucune ligne : les membres, sites et rapports restent. Le
 * compte est banni, ses sessions tombent et ses clés API personnelles sont désactivées.
 * Les clés d'organisation restent : elles n'appartiennent pas à cet utilisateur.
 *
 * `revoke_sessions: true` coupe seulement les sessions, sans toucher au compte ni aux clés :
 * le Hub l'envoie pour « se déconnecter partout » et après un changement de mot de passe.
 *
 * `/hub/users` liste aussi les comptes pas encore liés (`hub_user_id` nul) : c'est ce qui
 * permet à `hub reconcile` de les signaler. Seuls les comptes supprimés par le Hub en sortent.
 */
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../db/postgres/postgres.js";
import { apiKey, session, user } from "../../db/postgres/schema.js";
import { invalidateSitesAccessCache } from "../../lib/auth-utils.js";
import { allowHubRequest } from "./hubAuth.js";
import { isValidEmail } from "./workspaces.js";

const HUB_DELETED_REASON = "hub_deleted";
const PG_UNIQUE_VIOLATION = "23505";

const syncSchema = z.object({
  hub_user_id: z.string().trim().min(1).max(255),
  // `user.name` n'accepte pas NULL : un nom vide au Hub ne remplace pas celui d'ici.
  name: z.string().trim().min(1).max(255).nullable().optional(),
  email: z.string().trim().toLowerCase().optional(),
  deleted: z.boolean().optional(),
  revoke_sessions: z.boolean().optional(),
});

export async function listHubUsers(req: FastifyRequest, res: FastifyReply) {
  if (!allowHubRequest(req, res, "")) {
    return;
  }
  try {
    const rows = await db
      .select({ hubUserId: user.hubUserId, email: user.email, name: user.name })
      .from(user)
      .where(or(isNull(user.banReason), ne(user.banReason, HUB_DELETED_REASON)));
    return res.status(200).send({
      users: rows.map(row => ({ hub_user_id: row.hubUserId, email: row.email, name: row.name })),
    });
  } catch (err) {
    req.log.error({ err }, "Erreur dans listHubUsers");
    return res.status(500).send({ error: "Internal error" });
  }
}

async function cutAccess(userId: string) {
  await db.transaction(async tx => {
    await tx
      .update(user)
      .set({ banned: true, banReason: HUB_DELETED_REASON, updatedAt: new Date().toISOString() })
      .where(eq(user.id, userId));
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.update(apiKey).set({ enabled: false }).where(eq(apiKey.referenceId, userId));
  });
  invalidateSitesAccessCache(userId);
}

export async function syncHubUser(req: FastifyRequest<{ Body: string }>, res: FastifyReply) {
  const rawBody = typeof req.body === "string" ? req.body : "";
  if (!allowHubRequest(req, res, rawBody)) {
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return res.status(400).send({ error: "invalid_payload" });
  }
  const parsed = syncSchema.safeParse(json);
  if (!parsed.success || (parsed.data.email !== undefined && !isValidEmail(parsed.data.email))) {
    return res.status(400).send({ error: "invalid_payload" });
  }
  const { hub_user_id: hubUserId, name, email, deleted, revoke_sessions: revokeSessions } = parsed.data;

  try {
    const [account] = await db
      .select({ id: user.id, email: user.email, name: user.name, banReason: user.banReason })
      .from(user)
      .where(eq(user.hubUserId, hubUserId))
      .limit(1);
    if (!account) {
      return res.status(404).send({ error: "user_not_in_app" });
    }

    if (deleted === true) {
      if (account.banReason === HUB_DELETED_REASON) {
        return res.status(200).send({ updated: false });
      }
      await cutAccess(account.id);
      req.log.info({ userId: account.id, hubUserId }, "Accès coupé à la demande du Hub");
      return res.status(200).send({ updated: true });
    }

    const changes: { name?: string; email?: string; emailVerified?: boolean } = {};
    if (name && name !== account.name) {
      changes.name = name;
    }
    if (email !== undefined && email !== account.email.toLowerCase()) {
      const [other] = await db
        .select({ id: user.id })
        .from(user)
        .where(and(sql`lower(${user.email}) = ${email}`, ne(user.id, account.id)))
        .limit(1);
      if (other) {
        req.log.error({ userId: account.id, hubUserId }, "Synchro Hub refusée : adresse déjà prise");
        return res.status(409).send({ error: "email_conflict" });
      }
      // Le Hub ne pousse qu'une adresse prouvée (§3.8).
      changes.email = email;
      changes.emailVerified = true;
    }
    const hasChanges = Object.keys(changes).length > 0;
    if (hasChanges) {
      await db
        .update(user)
        .set({ ...changes, updatedAt: new Date().toISOString() })
        .where(eq(user.id, account.id));
    }
    let revoked = 0;
    if (revokeSessions === true) {
      const removed = await db.delete(session).where(eq(session.userId, account.id)).returning({ id: session.id });
      revoked = removed.length;
      req.log.info({ userId: account.id, hubUserId, revoked }, "Sessions coupées à la demande du Hub");
    }
    return res.status(200).send({ updated: hasChanges || revoked > 0 });
  } catch (err) {
    if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      return res.status(409).send({ error: "email_conflict" });
    }
    req.log.error({ err }, "Erreur dans syncHubUser");
    return res.status(500).send({ error: "Internal error" });
  }
}
