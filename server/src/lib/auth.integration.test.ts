import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Le vrai `auth.ts` sur le vrai schéma : un Postgres embarqué (PGlite), toutes les migrations
 * du dépôt appliquées. C'est ce qui vérifie une montée de better-auth : le plugin valide ses
 * tables et lit nos colonnes, ce qu'aucun test sur adaptateur mémoire ne voit.
 */
const BASE = vi.hoisted(() => {
  const base = "https://analytics.exemple.fr";
  // Colonnes sans fuseau : comme en prod et en CI. Sur un poste en CET, un jeton de
  // 2 minutes paraîtrait déjà périmé.
  process.env.TZ = "UTC";
  process.env.BETTER_AUTH_URL = base;
  process.env.BETTER_AUTH_SECRET = "secret-de-test-0123456789-0123456789";
  process.env.DISABLE_SIGNUP = "true";
  return base;
});

const pglite = vi.hoisted(() => ({ client: null as any }));

vi.mock("../db/postgres/postgres.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../db/postgres/schema.js");
  pglite.client = new PGlite();
  // Avant l'import d'`auth.ts` : better-auth valide le schéma dès son initialisation.
  const { readdirSync, readFileSync } = await import("fs");
  const dir = new URL("../../drizzle/", import.meta.url);
  for (const file of readdirSync(dir)
    .filter(name => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) {
        await pglite.client.exec(statement);
      }
    }
  }
  return { db: drizzle(pglite.client, { schema }), sql: pglite.client };
});

// `auth.ts` ouvre un pg.Pool : même base, par une couche mince.
vi.mock("pg", () => {
  class Pool {
    async connect() {
      return {
        query: async (text: string, params?: unknown[]) => {
          const result = await pglite.client.query(text, params);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: "" };
        },
        release: () => {},
      };
    }
    async query(text: string, params?: unknown[]) {
      const connection = await this.connect();
      return connection.query(text, params);
    }
    async end() {}
    on() {
      return this;
    }
  }
  return { default: { Pool }, Pool };
});

vi.mock("../db/redis/redis.js", () => ({ redis: {}, apiRateLimitRedis: {}, apiRateLimitConsume: vi.fn() }));
vi.mock("./brand.js", async importOriginal => ({
  BRAND: { ...(await importOriginal<typeof import("./brand.js")>()).BRAND, appUrl: BASE },
}));

import { createMagicLink } from "../api/veridian/issueMagicLink.js";
import { db } from "../db/postgres/postgres.js";
import { session } from "../db/postgres/schema.js";
import { auth } from "./auth.js";

const EMAIL = "client@exemple.fr";
const PASSWORD = "MotDePasse-Test-1";
const HEADERS = { origin: BASE, "content-type": "application/json", "x-forwarded-for": "203.0.113.9" };

const post = (path: string, body: unknown, cookie?: string) =>
  auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    })
  );

const getSession = async (cookie: string) => {
  const res = await auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }));
  return res.json() as Promise<{ user?: { email: string } } | null>;
};

const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map(cookie => cookie.split(";")[0])
    .join("; ");

beforeAll(async () => {
  // Compte écrit comme ceux de la prod : mot de passe local, adresse non vérifiée.
  const context = await auth.$context;
  const created = await context.internalAdapter.createUser(
    { email: EMAIL, name: "Client", emailVerified: true },
    { method: "admin" }
  );
  await context.internalAdapter.createAccount({
    userId: created.id,
    providerId: "credential",
    accountId: created.id,
    password: await context.password.hash(PASSWORD),
  });
});

afterAll(async () => {
  await pglite.client.close();
});

describe("auth.ts sur le schéma migré", () => {
  it("connecte par mot de passe et lit la session", async () => {
    const res = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(200);
    expect((await getSession(cookieOf(res)))?.user?.email).toBe(EMAIL);
  });

  it("refuse un mauvais mot de passe", async () => {
    const res = await post("/sign-in/email", { email: EMAIL, password: "faux-mot-de-passe" });

    expect(res.status).toBe(401);
  });

  it("le lien du rebond ouvre une session, une seule fois, sur la page demandée", async () => {
    const link = await createMagicLink(EMAIL, `${BASE}/25/main`);

    const first = await auth.handler(new Request(link));
    const replay = await auth.handler(new Request(link));

    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe(`${BASE}/25/main`);
    expect((await getSession(cookieOf(first)))?.user?.email).toBe(EMAIL);
    expect(replay.headers.get("location")).toContain("INVALID_TOKEN");
    expect(replay.headers.getSetCookie().join()).not.toContain("session_token=");
  });

  it("crée et vérifie une clé API, seule authentification du MCP", async () => {
    const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });

    const created = await post("/api-key/create", { name: "test" }, cookieOf(signIn));
    const { key } = (await created.json()) as { key: string };

    expect(created.status).toBe(200);
    expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(true);
    expect((await auth.api.verifyApiKey({ body: { key: "rb_fausse" } })).valid).toBe(false);
  });

  it("crée une organisation et une équipe, et tient le compte de ses membres", async () => {
    const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    const cookie = cookieOf(signIn);

    const created = await post("/organization/create", { name: "Org", slug: "org-test" }, cookie);
    const organization = (await created.json()) as { id: string };
    const team = await post("/organization/create-team", { name: "Equipe", organizationId: organization.id }, cookie);
    const { id: teamId } = (await team.json()) as { id: string };
    const [account] = (await pglite.client.query(`SELECT "id" FROM "user" WHERE "email" = $1`, [EMAIL])).rows as {
      id: string;
    }[];
    const added = await post("/organization/add-team-member", { teamId, userId: account.id }, cookie);

    expect(created.status).toBe(200);
    expect(team.status).toBe(200);
    expect(added.status).toBe(200);
    const counted = await pglite.client.query(`SELECT "memberCount" FROM "team" WHERE "id" = $1`, [teamId]);
    expect((counted.rows[0] as { memberCount: number }).memberCount).toBe(1);
  });

  it("coupe la session quand ses lignes sont supprimées, comme revoke_sessions", async () => {
    const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    const cookie = cookieOf(signIn);
    expect((await getSession(cookie))?.user?.email).toBe(EMAIL);

    await db.delete(session);

    expect(await getSession(cookie)).toBeNull();
  });

  it("déconnecte", async () => {
    const signIn = await post("/sign-in/email", { email: EMAIL, password: PASSWORD });
    const cookie = cookieOf(signIn);

    await post("/sign-out", {}, cookie);

    expect(await getSession(cookie)).toBeNull();
  });
});
