import { readFileSync } from "fs";
import { createHmac } from "crypto";
import Fastify, { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "hub-shared-secret-0123456789";
const EMAIL = "client@exemple.fr";

const state = vi.hoisted(() => ({
  found: null as unknown,
  counter: 0,
  redisDown: false,
  linked: [] as { email: string }[],
  linkResult: [{ id: "user-1" }] as { id: string }[],
  linkWrites: [] as unknown[],
  lookups: [] as string[],
}));

/**
 * Le VRAI better-auth et le VRAI plugin `magicLink`, sur un adaptateur mémoire :
 * le jeton déposé par le handler doit être compris et consommé par le plugin,
 * c'est tout l'objet de ce test.
 */
const authModule = vi.hoisted(() => ({ auth: null as any, db: {} as Record<string, any[]> }));

vi.mock("../../lib/auth.js", async () => {
  const { betterAuth } = await import("better-auth");
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  const { magicLink } = await import("better-auth/plugins");
  authModule.db = { user: [], session: [], account: [], verification: [] };
  authModule.auth = betterAuth({
    basePath: "/api/auth",
    baseURL: "https://analytics.veridian.site",
    secret: "secret-de-test-0123456789-0123456789",
    database: memoryAdapter(authModule.db),
    plugins: [magicLink({ storeToken: "hashed", disableSignUp: true, sendMagicLink: async () => {} })],
  });
  return {
    get auth() {
      return authModule.auth;
    },
  };
});

vi.mock("../../db/postgres/postgres.js", () => {
  const read: Record<string, unknown> = {};
  read.from = () => read;
  read.where = () => read;
  read.limit = async () => state.linked;
  const write: Record<string, unknown> = {};
  write.set = (values: unknown) => {
    state.linkWrites.push(values);
    return write;
  };
  write.where = () => write;
  write.returning = async () => state.linkResult;
  return { db: { select: () => read, update: () => write } };
});

vi.mock("../../db/redis/redis.js", () => ({
  redis: {
    incr: async () => {
      if (state.redisDown) {
        throw new Error("redis indisponible");
      }
      state.counter += 1;
      return state.counter;
    },
    expire: async () => 1,
  },
}));

/** Vitest pose `BASE_URL=/`, que `brand.ts` lirait comme l'URL de l'instance. */
vi.mock("../../lib/brand.js", () => ({ BRAND: { appUrl: "https://analytics.veridian.site" } }));

/** La résolution des sites a ses propres tests (`getUserByEmail.test.ts`). */
vi.mock("./workspaces.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./workspaces.js")>()),
  findAccountWorkspaces: async (email: string) => {
    state.lookups.push(email);
    return state.found;
  },
}));

import { hubRoutes } from "./routes.js";

function sign(timestamp: number, body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

let app: FastifyInstance;

function post(body: string, options: { timestamp?: number; signature?: string } = {}) {
  const timestamp = options.timestamp ?? Date.now();
  return app.inject({
    method: "POST",
    url: "/api/sso/issue-magic-link",
    headers: {
      "content-type": "application/json",
      "x-veridian-timestamp": String(timestamp),
      "x-veridian-hub-signature": options.signature ?? sign(timestamp, body),
    },
    payload: body,
  });
}

const validBody = (email = EMAIL) => JSON.stringify({ hub_user_id: "hub-uuid-1", email, email_proven: true });

/** Suit le lien comme un navigateur : la redirection n'est pas suivie, on la lit. */
function follow(url: string) {
  return authModule.auth.handler(new Request(url, { redirect: "manual" })) as Promise<Response>;
}

beforeAll(async () => {
  app = Fastify();
  await app.register(hubRoutes, { prefix: "/api" });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  process.env.HUB_API_SECRET = SECRET;
  state.counter = 0;
  state.redisDown = false;
  state.linked = [];
  state.linkResult = [{ id: "user-1" }];
  state.linkWrites = [];
  state.lookups = [];
  state.found = {
    account: { id: "user-1", email: EMAIL, banned: false, hubUserId: null },
    workspaces: [{ workspace_id: "1" }],
  };
  authModule.db.user.length = 0;
  authModule.db.session.length = 0;
  authModule.db.verification.length = 0;
  authModule.db.user.push({
    id: "user-1",
    email: EMAIL,
    name: "Client",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.HUB_API_SECRET;
});

describe("issue-magic-link : authentification", () => {
  it("répond 401 sur une signature fausse, sans déposer de jeton", async () => {
    const timestamp = Date.now();
    const res = await post(validBody(), { timestamp, signature: sign(timestamp, validBody(), "mauvais-secret") });

    expect(res.statusCode).toBe(401);
    expect(authModule.db.verification).toHaveLength(0);
  });

  it("répond 401 quand le corps diffère de celui qui a été signé", async () => {
    const timestamp = Date.now();
    const res = await post(validBody("autre@exemple.fr"), { timestamp, signature: sign(timestamp, validBody()) });

    expect(res.statusCode).toBe(401);
  });

  it("signe les octets reçus, pas leur réécriture : un JSON espacé reste valide", async () => {
    const res = await post(`{ "hub_user_id": "hub-uuid-1",   "email": "${EMAIL}",  "email_proven": true }`);

    expect(res.statusCode).toBe(200);
  });

  it("répond 401 sur un horodatage de plus de 5 minutes, même bien signé", async () => {
    const res = await post(validBody(), { timestamp: Date.now() - 6 * 60 * 1000 });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Timestamp expired or invalid" });
  });

  it("répond 500 quand le secret n'est pas configuré", async () => {
    const body = validBody();
    const timestamp = Date.now();
    const signature = sign(timestamp, body);
    delete process.env.HUB_API_SECRET;

    const res = await post(body, { timestamp, signature });

    expect(res.statusCode).toBe(500);
    expect(authModule.db.verification).toHaveLength(0);
  });
});

describe("issue-magic-link : contrat", () => {
  it("répond 400 user_not_in_app pour un utilisateur inconnu ou sans site", async () => {
    state.found = null;

    const res = await post(validBody());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "user_not_in_app", hint: "no workspace for this hub_user_id" });
    expect(authModule.db.verification).toHaveLength(0);
  });

  it("répond 400 user_not_in_app pour un utilisateur banni", async () => {
    state.found = {
      account: { id: "user-1", email: EMAIL, banned: true, hubUserId: null },
      workspaces: [{ workspace_id: "1" }],
    };

    const res = await post(validBody());

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("user_not_in_app");
  });

  it.each([
    ["JSON illisible", "{pas du json"],
    ["hub_user_id manquant", JSON.stringify({ email: EMAIL })],
    ["hub_user_id vide", JSON.stringify({ hub_user_id: "  ", email: EMAIL })],
    ["adresse invalide", JSON.stringify({ hub_user_id: "x", email: "pas-une-adresse" })],
  ])("répond 400 invalid_payload : %s", async (_name, body) => {
    const res = await post(body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_payload" });
  });

  it("répond 429 au-delà de 10 liens par minute", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post(validBody())).statusCode).toBe(200);
    }

    const res = await post(validBody());

    expect(res.statusCode).toBe(429);
    expect(authModule.db.verification).toHaveLength(10);
  });

  it("émet quand même le lien si Redis est indisponible", async () => {
    state.redisDown = true;

    expect((await post(validBody())).statusCode).toBe(200);
  });
});

describe("issue-magic-link : rattachement au Hub", () => {
  const foundWith = (hubUserId: string | null) => ({
    account: { id: "user-1", email: EMAIL, banned: false, hubUserId },
    workspaces: [{ workspace_id: "1" }],
  });

  it("écrit le lien sur un compte encore sans lien", async () => {
    const res = await post(validBody());

    expect(res.statusCode).toBe(200);
    expect(state.linkWrites).toEqual([{ hubUserId: "hub-uuid-1", emailVerified: true }]);
  });

  it("résout par hub_user_id d'abord : un email changé au Hub retrouve le compte", async () => {
    state.linked = [{ email: EMAIL }];
    state.found = foundWith("hub-uuid-1");

    const res = await post(validBody("nouvelle-adresse@exemple.fr"));

    expect(res.statusCode).toBe(200);
    expect(state.lookups).toEqual([EMAIL]);
    expect(state.linkWrites).toHaveLength(0);
  });

  it("accepte un identifiant qui n'est pas un UUID : le format est libre", async () => {
    const res = await post(JSON.stringify({ hub_user_id: "cuid_abc123", email: EMAIL, email_proven: true }));

    expect(res.statusCode).toBe(200);
    expect(state.linkWrites).toEqual([{ hubUserId: "cuid_abc123", emailVerified: true }]);
  });

  it.each([
    ["absent", {}],
    ["faux", { email_proven: false }],
  ])("ne rattache rien par email quand email_proven est %s", async (_name, extra) => {
    const res = await post(JSON.stringify({ hub_user_id: "hub-uuid-1", email: EMAIL, ...extra }));

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("user_not_in_app");
    expect(state.lookups).toHaveLength(0);
    expect(state.linkWrites).toHaveLength(0);
    expect(authModule.db.verification).toHaveLength(0);
  });

  it("se fie au seul hub_user_id quand le compte est déjà lié, sans email_proven", async () => {
    state.linked = [{ email: EMAIL }];
    state.found = foundWith("hub-uuid-1");

    const res = await post(JSON.stringify({ hub_user_id: "hub-uuid-1", email: "autre@exemple.fr" }));

    expect(res.statusCode).toBe(200);
    expect(state.lookups).toEqual([EMAIL]);
  });

  it("refuse sans lien un compte déjà lié à un autre hub_user_id, et n'y écrit rien", async () => {
    state.found = foundWith("autre-compte-hub");

    const res = await post(validBody());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "hub_user_conflict" });
    expect(state.linkWrites).toHaveLength(0);
    expect(authModule.db.verification).toHaveLength(0);
  });

  it("refuse sans lien quand un rebond concurrent a lié le compte entre-temps", async () => {
    state.linkResult = [];

    const res = await post(validBody());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "hub_user_conflict" });
    expect(authModule.db.verification).toHaveLength(0);
  });

  it.each([
    ["inconnu", () => null],
    ["banni", () => ({ ...foundWith(null), account: { ...foundWith(null).account, banned: true } })],
  ])("n'écrit aucun lien pour un compte %s", async (_name, found) => {
    state.found = found();

    await post(validBody());

    expect(state.linkWrites).toHaveLength(0);
  });
});

describe("issue-magic-link : le lien, avec le vrai plugin better-auth", () => {
  async function issue() {
    const res = await post(validBody());
    expect(res.statusCode).toBe(200);
    return res.json().magic_link_url as string;
  }

  it("connecte l'utilisateur : session posée, redirection vers l'application", async () => {
    const res = await follow(await issue());

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://analytics.veridian.site/");
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=");
    expect(authModule.db.session.map(s => s.userId)).toEqual(["user-1"]);
  });

  it("refuse le rejeu : la seconde visite ne crée aucune session", async () => {
    const url = await issue();
    await follow(url);

    const replay = await follow(url);

    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("https://analytics.veridian.site/login?error=INVALID_TOKEN");
    expect(replay.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(authModule.db.session).toHaveLength(1);
  });

  it("refuse un lien périmé après 2 minutes", async () => {
    const url = await issue();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60 * 1000 + 1000 });

    const res = await follow(url);

    expect(res.headers.get("location")).toBe("https://analytics.veridian.site/login?error=INVALID_TOKEN");
    expect(authModule.db.session).toHaveLength(0);
  });

  it("accepte encore le lien juste avant 2 minutes", async () => {
    const url = await issue();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60 * 1000 - 5000 });

    const res = await follow(url);

    expect(res.headers.get("location")).toBe("https://analytics.veridian.site/");
  });

  async function issueTo(next: unknown) {
    const res = await post(JSON.stringify({ hub_user_id: "hub-uuid-1", email: EMAIL, email_proven: true, next }));
    expect(res.statusCode).toBe(200);
    return res.json().magic_link_url as string;
  }

  it("ramène sur la page demandée quand elle est sur l'origine de l'application", async () => {
    const res = await follow(await issueTo("https://analytics.veridian.site/25/main?timeMode=day"));

    expect(res.headers.get("location")).toBe("https://analytics.veridian.site/25/main?timeMode=day");
    expect(authModule.db.session).toHaveLength(1);
  });

  it.each([
    ["une autre origine", "https://evil.example/25/main"],
    ["un sous-domaine voisin", "https://evil.analytics.veridian.site/"],
    ["un autre schéma", "javascript:alert(1)"],
    ["une double barre", "https://analytics.veridian.site//evil.example/x"],
    ["une barre inverse", "https://analytics.veridian.site/\\evil.example/x"],
    ["une adresse illisible", "pas une url"],
  ])("renvoie sur l'accueil pour %s", async (_name, next) => {
    const res = await follow(await issueTo(next));

    expect(res.headers.get("location")).toBe("https://analytics.veridian.site/");
  });

  it("ne stocke jamais le jeton en clair", async () => {
    const token = new URL(await issue()).searchParams.get("token");

    expect(token).toBeTruthy();
    expect(JSON.stringify(authModule.db.verification)).not.toContain(token);
  });

  it("repose sur la configuration réelle du plugin : jetons hachés, inscription fermée", () => {
    // Le test ci-dessus construit son propre plugin ; ce verrou le relie à la
    // configuration servie. Si `auth.ts` change l'une ou l'autre, le handler
    // doit changer avec lui.
    const source = readFileSync(new URL("../../lib/auth.ts", import.meta.url), "utf8");

    expect(source).toContain('storeToken: "hashed"');
    expect(source).toContain("disableSignUp: true");
  });
});
