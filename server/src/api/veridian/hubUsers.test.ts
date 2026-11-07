import { createHmac } from "crypto";
import Fastify, { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "hub-shared-secret-0123456789";

const state = vi.hoisted(() => ({
  selects: [] as unknown[][],
  selectCalls: 0,
  writes: [] as { op: string; table: unknown; values?: Record<string, unknown> }[],
  failUpdateWith: null as unknown,
  sessionsRemoved: [] as { id: string }[],
  invalidated: [] as string[],
}));

vi.mock("../../db/postgres/postgres.js", () => {
  const read: Record<string, unknown> = {};
  read.from = () => read;
  read.where = () => read;
  read.limit = () => read;
  read.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(state.selects.shift() ?? []).then(resolve, reject);
  const db = {
    select: () => {
      state.selectCalls += 1;
      return read;
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (state.failUpdateWith) {
            throw state.failUpdateWith;
          }
          state.writes.push({ op: "update", table, values });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        state.writes.push({ op: "delete", table });
        // Attendable tel quel (coupure d'accès) ou suivi de `returning` (revoke_sessions).
        return Object.assign(Promise.resolve(), {
          returning: async () => state.sessionsRemoved,
        });
      },
    }),
    transaction: async (callback: (tx: unknown) => Promise<void>) => callback(db),
  };
  return { db };
});

vi.mock("../../lib/auth-utils.js", () => ({
  invalidateSitesAccessCache: (id: string) => state.invalidated.push(id),
}));
vi.mock("../../db/redis/redis.js", () => ({ redis: {} }));
vi.mock("../../lib/auth.js", () => ({ auth: {} }));

import { apiKey, session, user } from "../../db/postgres/schema.js";
import { hubRoutes } from "./routes.js";

let app: FastifyInstance;

const sign = (timestamp: number, body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

function list(options: { timestamp?: number; signature?: string } = {}) {
  const timestamp = options.timestamp ?? Date.now();
  return app.inject({
    method: "GET",
    url: "/api/hub/users",
    headers: {
      "x-veridian-timestamp": String(timestamp),
      "x-veridian-hub-signature": options.signature ?? sign(timestamp, ""),
    },
  });
}

function sync(payload: unknown, options: { timestamp?: number; signature?: string } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const timestamp = options.timestamp ?? Date.now();
  return app.inject({
    method: "POST",
    url: "/api/hub/users/sync",
    headers: {
      "content-type": "application/json",
      "x-veridian-timestamp": String(timestamp),
      "x-veridian-hub-signature": options.signature ?? sign(timestamp, body),
    },
    payload: body,
  });
}

const ACCOUNT = { id: "user-1", email: "client@exemple.fr", name: "Client", banReason: null };

beforeAll(async () => {
  app = Fastify();
  await app.register(hubRoutes, { prefix: "/api" });
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  process.env.HUB_API_SECRET = SECRET;
  state.selects = [];
  state.selectCalls = 0;
  state.writes = [];
  state.failUpdateWith = null;
  state.sessionsRemoved = [];
  state.invalidated = [];
});

describe("GET /api/hub/users", () => {
  it("rend un tableau vide en JSON quand il n'y a aucun compte", async () => {
    state.selects = [[]];

    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ users: [] });
  });

  it("rend les comptes au format du contrat, y compris ceux sans lien", async () => {
    state.selects = [
      [
        { hubUserId: "hub-1", email: "a@exemple.fr", name: "A" },
        { hubUserId: null, email: "b@exemple.fr", name: "B" },
      ],
    ];

    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      users: [
        { hub_user_id: "hub-1", email: "a@exemple.fr", name: "A" },
        { hub_user_id: null, email: "b@exemple.fr", name: "B" },
      ],
    });
  });

  it("répond 401 sans rien lire sur une signature fausse", async () => {
    const timestamp = Date.now();

    const res = await list({ timestamp, signature: sign(timestamp, "", "mauvais-secret") });

    expect(res.statusCode).toBe(401);
    expect(state.selectCalls).toBe(0);
  });

  it("répond 401 sur un horodatage de plus de 5 minutes", async () => {
    const res = await list({ timestamp: Date.now() - 6 * 60 * 1000 });

    expect(res.statusCode).toBe(401);
    expect(state.selectCalls).toBe(0);
  });

  it("répond 500 sans rien lire quand le secret manque", async () => {
    const timestamp = Date.now();
    const signature = sign(timestamp, "");
    delete process.env.HUB_API_SECRET;

    const res = await list({ timestamp, signature });

    expect(res.statusCode).toBe(500);
    expect(state.selectCalls).toBe(0);
  });
});

describe("POST /api/hub/users/sync : authentification et validation", () => {
  it("répond 401 sans rien écrire quand le corps diffère de celui signé", async () => {
    const timestamp = Date.now();
    const signature = sign(timestamp, JSON.stringify({ hub_user_id: "hub-1", name: "A" }));

    const res = await sync({ hub_user_id: "hub-1", deleted: true }, { timestamp, signature });

    expect(res.statusCode).toBe(401);
    expect(state.selectCalls).toBe(0);
    expect(state.writes).toHaveLength(0);
  });

  it.each([
    ["JSON illisible", "{pas du json"],
    ["hub_user_id absent", { name: "A" }],
    ["adresse invalide", { hub_user_id: "hub-1", email: "pas-une-adresse" }],
  ])("répond 400 invalid_payload : %s", async (_name, payload) => {
    const res = await sync(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_payload" });
    expect(state.writes).toHaveLength(0);
  });
});

describe("POST /api/hub/users/sync : effets", () => {
  it("répond 404 user_not_in_app pour un identifiant inconnu, même avec une adresse connue", async () => {
    state.selects = [[]];

    const res = await sync({ hub_user_id: "inconnu", email: "client@exemple.fr", deleted: true });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "user_not_in_app" });
    expect(state.writes).toHaveLength(0);
    // Par `hub_user_id` uniquement : aucune seconde lecture par email.
    expect(state.selectCalls).toBe(1);
  });

  it("n'applique que le nom quand seul le nom est présent", async () => {
    state.selects = [[ACCOUNT]];

    const res = await sync({ hub_user_id: "hub-1", name: "Nouveau" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: true });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].table).toBe(user);
    expect(state.writes[0].values).toMatchObject({ name: "Nouveau" });
    expect(state.writes[0].values).not.toHaveProperty("email");
    expect(state.writes[0].values).not.toHaveProperty("banned");
  });

  it("répond updated:false sans écrire quand le nom est déjà le bon", async () => {
    state.selects = [[ACCOUNT]];

    const res = await sync({ hub_user_id: "hub-1", name: "Client" });

    expect(res.json()).toEqual({ updated: false });
    expect(state.writes).toHaveLength(0);
  });

  it("ignore un nom nul au lieu de l'écrire", async () => {
    state.selects = [[ACCOUNT]];

    const res = await sync({ hub_user_id: "hub-1", name: null });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: false });
    expect(state.writes).toHaveLength(0);
  });

  it("change l'adresse, en minuscules, et la marque prouvée", async () => {
    state.selects = [[ACCOUNT], []];

    const res = await sync({ hub_user_id: "hub-1", email: "Nouvelle@Exemple.FR" });

    expect(res.statusCode).toBe(200);
    expect(state.writes[0].values).toMatchObject({ email: "nouvelle@exemple.fr", emailVerified: true });
  });

  it("n'écrit rien quand l'adresse est déjà la bonne, casse comprise", async () => {
    state.selects = [[ACCOUNT]];

    const res = await sync({ hub_user_id: "hub-1", email: "CLIENT@exemple.fr" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: false });
    expect(state.writes).toHaveLength(0);
  });

  it("refuse 409 une adresse prise par un autre compte, sans écrire", async () => {
    state.selects = [[ACCOUNT], [{ id: "user-2" }]];

    const res = await sync({ hub_user_id: "hub-1", email: "prise@exemple.fr" });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "email_conflict" });
    expect(state.writes).toHaveLength(0);
  });

  it("répond 409 quand la contrainte d'unicité tranche une course", async () => {
    state.selects = [[ACCOUNT], []];
    state.failUpdateWith = { code: "23505" };

    const res = await sync({ hub_user_id: "hub-1", email: "prise@exemple.fr" });

    expect(res.statusCode).toBe(409);
  });

  it("deleted : bannit, coupe les sessions et les clés personnelles, sans supprimer le compte", async () => {
    state.selects = [[ACCOUNT]];

    const res = await sync({ hub_user_id: "hub-1", deleted: true, name: "Ignoré" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: true });
    const banned = state.writes.find(w => w.table === user);
    expect(banned?.op).toBe("update");
    expect(banned?.values).toMatchObject({ banned: true, banReason: "hub_deleted" });
    expect(banned?.values).not.toHaveProperty("name");
    expect(state.writes.find(w => w.table === session)?.op).toBe("delete");
    expect(state.writes.find(w => w.table === apiKey)?.values).toEqual({ enabled: false });
    expect(state.writes.filter(w => w.op === "delete" && w.table === user)).toHaveLength(0);
    expect(state.invalidated).toEqual(["user-1"]);
  });

  it("deleted est idempotent : le second appel répond updated:false sans écrire", async () => {
    state.selects = [[{ ...ACCOUNT, banReason: "hub_deleted" }]];

    const res = await sync({ hub_user_id: "hub-1", deleted: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: false });
    expect(state.writes).toHaveLength(0);
  });

  it("revoke_sessions coupe les sessions sans toucher au compte ni aux clés", async () => {
    state.selects = [[ACCOUNT]];
    state.sessionsRemoved = [{ id: "s1" }, { id: "s2" }];

    const res = await sync({ hub_user_id: "hub-1", revoke_sessions: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: true });
    expect(state.writes).toEqual([{ op: "delete", table: session }]);
  });

  it("revoke_sessions est idempotent : updated:false quand il ne restait aucune session", async () => {
    state.selects = [[ACCOUNT]];

    const res = await sync({ hub_user_id: "hub-1", revoke_sessions: true });

    expect(res.json()).toEqual({ updated: false });
  });

  it("revoke_sessions sur un identifiant inconnu répond 404 et ne coupe rien", async () => {
    state.selects = [[]];

    const res = await sync({ hub_user_id: "inconnu", revoke_sessions: true });

    expect(res.statusCode).toBe(404);
    expect(state.writes).toHaveLength(0);
  });

  it("revoke_sessions sans vrai booléen n'est pas appliqué : le corps est refusé", async () => {
    const res = await sync({ hub_user_id: "hub-1", revoke_sessions: "oui" });

    expect(res.statusCode).toBe(400);
    expect(state.writes).toHaveLength(0);
  });

  it("répond 500 sur une erreur d'infrastructure", async () => {
    state.selects = [[ACCOUNT]];
    state.failUpdateWith = new Error("base indisponible");

    const res = await sync({ hub_user_id: "hub-1", name: "Nouveau" });

    expect(res.statusCode).toBe(500);
  });
});
