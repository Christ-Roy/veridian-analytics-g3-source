/**
 * POST /api/sso/issue-magic-link
 *
 * Rebond Hub (CONTRAT-HUB §6bis.8.3). Le client est connecté au Hub : le Hub
 * demande ici un lien de connexion et y redirige le navigateur, sans que le
 * client ressaisisse de mot de passe.
 *
 * Le jeton est celui du plugin `magicLink` de better-auth, déposé dans sa table
 * `verification` au format qu'il attend : c'est lui qui le consomme, atomiquement,
 * sur `GET /api/auth/magic-link/verify`. Pas de second mécanisme de session à
 * maintenir, et aucun fichier amont à modifier. Ce format n'est pas une API
 * publique du plugin : `issueMagicLink.test.ts` fait l'aller-retour avec le vrai
 * plugin et rougit si une montée de version le change.
 *
 * `hub_user_id` est la clé de jointure, parce qu'un email change : on résout
 * d'abord par elle. Le repli par email ne sert qu'à rattacher un compte encore
 * sans lien, et seulement si le Hub atteste la preuve de l'adresse (`email_proven`,
 * §3.8). Puis le lien est écrit. Un lien posé ne change jamais (§3.7).
 *
 * Authentification : HMAC Hub sur le corps brut (cf `lib/hubHmac.ts`). Fail-closed.
 *
 * Réponses :
 *   200 { magic_link_url }
 *   400 { error: "user_not_in_app", hint }   inconnu, banni, sans site visible, ou sans lien ni email_proven
 *   400 { error: "invalid_payload" }
 *   400 { error: "hub_user_conflict" }       compte déjà lié à un autre hub_user_id
 *   401 { error: ... }                       signature absente, fausse ou périmée
 *   429 { error: "rate_limited" }            plus de 10 liens par minute et par utilisateur
 *   500 { error: ... }
 */
import { createHash, randomBytes } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../db/postgres/postgres.js";
import { user } from "../../db/postgres/schema.js";
import { redis } from "../../db/redis/redis.js";
import { auth } from "../../lib/auth.js";
import { BRAND } from "../../lib/brand.js";
import { allowHubRequest } from "./hubAuth.js";
import { findAccountWorkspaces, isValidEmail } from "./workspaces.js";

/** Le Hub redirige aussitôt : deux minutes couvrent une redirection lente. */
const TOKEN_TTL_MS = 2 * 60 * 1000;

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

const bodySchema = z.object({
  // Pas d'UUID imposé : le Hub arbitre le format de son identifiant.
  hub_user_id: z.string().trim().min(1).max(255),
  email: z.string().trim().toLowerCase(),
  email_proven: z.boolean().optional(),
  next: z.string().max(2048).optional(),
});

export type IssueMagicLinkRequest = FastifyRequest<{ Body: string }>;

/** Même empreinte que `defaultKeyHasher` du plugin avec `storeToken: "hashed"`. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Filet si le Hub est compromis, pas une défense de premier rang : Redis
 * indisponible ne doit pas couper la connexion de tous les clients.
 */
async function isRateLimited(userId: string, log: FastifyRequest["log"]): Promise<boolean> {
  try {
    const key = `veridian:sso:issue:${userId}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    }
    return count > RATE_LIMIT_MAX;
  } catch (err) {
    log.error({ err }, "Limite de débit du rebond Hub indisponible : lien émis quand même");
    return false;
  }
}

/** L'adresse liée à ce `hub_user_id`, sinon celle que le Hub atteste avoir prouvée. */
async function resolveEmail(hubUserId: string, email: string, emailProven: boolean): Promise<string | null> {
  const [linked] = await db.select({ email: user.email }).from(user).where(eq(user.hubUserId, hubUserId)).limit(1);
  if (linked) {
    return linked.email.toLowerCase();
  }
  return emailProven ? email : null;
}

/**
 * Écriture conditionnelle : deux rebonds simultanés ne peuvent pas lier deux identifiants.
 *
 * `emailVerified` passe à vrai avec le lien, puisque le Hub a prouvé l'adresse. Sinon le
 * plugin, à la vérification, supprimerait le mot de passe et les sessions du compte
 * (`revokeUnprovenAccountAccess`) : la fermeture de la connexion par mot de passe se
 * décide, elle ne se produit pas en effet de bord d'un premier rebond.
 */
async function linkHubUser(userId: string, hubUserId: string): Promise<boolean> {
  const updated = await db
    .update(user)
    .set({ hubUserId, emailVerified: true })
    .where(and(eq(user.id, userId), isNull(user.hubUserId)))
    .returning({ id: user.id });
  return updated.length === 1;
}

/**
 * Où renvoyer après connexion (§6bis.8.0) : le chemin demandé s'il est sur l'origine de
 * l'application, sinon l'accueil. Le chemin relatif évite toute redirection ouverte, à
 * condition d'écarter `//hote`, qu'un navigateur lit comme une autre origine.
 */
export function safeCallbackPath(next: string | undefined): string {
  if (!next) {
    return "/";
  }
  try {
    const url = new URL(next);
    if (url.origin !== new URL(BRAND.appUrl).origin || /^[/\\]{2}/.test(url.pathname)) {
      return "/";
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

export async function createMagicLink(email: string, next: string | undefined): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const context = await auth.$context;
  await context.internalAdapter.createVerificationValue({
    identifier: `magic-link:${hashToken(token)}`,
    value: JSON.stringify({ type: "magic-link", email }),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  const url = new URL("/api/auth/magic-link/verify", BRAND.appUrl);
  url.searchParams.set("token", token);
  // Relatifs : le contrôle d'origine du plugin les accepte sans liste blanche.
  url.searchParams.set("callbackURL", safeCallbackPath(next));
  // Un lien déjà consommé ou périmé mène à l'écran de connexion, pas à une erreur brute.
  url.searchParams.set("errorCallbackURL", "/login");
  return url.toString();
}

export async function issueMagicLink(req: IssueMagicLinkRequest, res: FastifyReply) {
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
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success || !isValidEmail(parsed.data.email)) {
    return res.status(400).send({ error: "invalid_payload" });
  }

  try {
    const hubUserId = parsed.data.hub_user_id;
    const email = await resolveEmail(hubUserId, parsed.data.email, parsed.data.email_proven === true);
    const found = email ? await findAccountWorkspaces(email) : null;
    if (!found || found.account.banned) {
      return res.status(400).send({ error: "user_not_in_app", hint: "no workspace for this hub_user_id" });
    }

    const refuseConflict = () => {
      req.log.error({ userId: found.account.id, hubUserId }, "Rebond Hub refusé : compte lié à un autre hub_user_id");
      return res.status(400).send({ error: "hub_user_conflict" });
    };
    if (found.account.hubUserId && found.account.hubUserId !== hubUserId) {
      return refuseConflict();
    }

    if (await isRateLimited(found.account.id, req.log)) {
      req.log.warn({ userId: found.account.id }, "Rebond Hub : limite de débit atteinte");
      return res.status(429).send({ error: "rate_limited" });
    }

    if (!found.account.hubUserId && !(await linkHubUser(found.account.id, hubUserId))) {
      return refuseConflict();
    }

    return res.status(200).send({ magic_link_url: await createMagicLink(found.account.email, parsed.data.next) });
  } catch (err) {
    req.log.error({ err }, "Erreur dans issueMagicLink");
    return res.status(500).send({ error: "Internal error" });
  }
}
