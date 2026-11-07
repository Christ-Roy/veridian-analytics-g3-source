import { createHmac } from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "hub-shared-secret-0123456789";
const NOW = 1_800_000_000_000;

/**
 * File de résultats consommée dans l'ordre des requêtes du handler :
 * utilisateur, appartenances, organisations, sites.
 */
const dbState = vi.hoisted(() => ({
  results: [] as unknown[][],
  selectCalls: 0,
}));

vi.mock("../../db/postgres/postgres.js", () => {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = self;
  chain.where = self;
  chain.limit = self;
  chain.innerJoin = self;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(dbState.results.shift() ?? []).then(resolve, reject);
  return {
    db: {
      select: () => {
        dbState.selectCalls += 1;
        return chain;
      },
    },
  };
});

/**
 * `resolveMemberSiteGrants` est une requête, pas une règle : on la simule.
 * `memberCanAccessSite` et `isOrgAdmin`, eux, PORTENT la règle d'accès —
 * ils restent réels, sinon ce test ne prouverait rien sur ce qu'un membre voit.
 */
const grantsState = vi.hoisted(() => ({
  explicitSiteIds: [] as number[],
  teamGatedSiteIds: [] as number[],
  userTeamSiteIds: [] as number[],
  calls: [] as unknown[],
}));

vi.mock("../../lib/access.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../lib/access.js")>();
  return {
    ...actual,
    resolveMemberSiteGrants: async (options: unknown) => {
      grantsState.calls.push(options);
      return {
        explicitSiteIds: new Set(grantsState.explicitSiteIds),
        teamGatedSiteIds: new Set(grantsState.teamGatedSiteIds),
        userTeamSiteIds: new Set(grantsState.userTeamSiteIds),
      };
    },
  };
});

import { BRAND } from "../../lib/brand.js";
import { getUserByEmail } from "./getUserByEmail.js";

function signGet(secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).digest("hex");
}

interface RequestOptions {
  email?: string;
  timestamp?: string;
  signature?: string;
}

function makeRequest(options: RequestOptions = {}): FastifyRequest<{ Querystring: { email?: string } }> {
  const timestamp = options.timestamp ?? String(NOW);
  return {
    headers: {
      "x-veridian-timestamp": timestamp,
      "x-veridian-hub-signature": options.signature ?? signGet(SECRET, Number(timestamp)),
    },
    query: { email: options.email ?? "client@exemple.fr" },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as FastifyRequest<{ Querystring: { email?: string } }>;
}

interface ReplyStub {
  statusCode: number | null;
  payload: any;
  status: (code: number) => ReplyStub;
  send: (payload: unknown) => ReplyStub;
}

function makeReply(): ReplyStub {
  const reply: ReplyStub = {
    statusCode: null,
    payload: undefined,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(payload: unknown) {
      reply.payload = payload;
      return reply;
    },
  };
  return reply;
}

const call = (request: ReturnType<typeof makeRequest>, reply: ReplyStub) =>
  getUserByEmail(request, reply as unknown as FastifyReply);

/** Jeux de lignes par défaut : un propriétaire, une organisation, deux sites. */
function seedOwnerWithTwoSites() {
  dbState.results = [
    [{ id: "user-1", email: "client@exemple.fr" }],
    [{ id: "member-1", userId: "user-1", organizationId: "org-1", role: "owner", hasRestrictedSiteAccess: false }],
    [{ id: "org-1", planOverride: null, customPlan: null }],
    [
      { siteId: 1, name: "Site vitrine", domain: "exemple.fr", organizationId: "org-1" },
      { siteId: 2, name: "Boutique", domain: "boutique.exemple.fr", organizationId: "org-1" },
    ],
  ];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.HUB_API_SECRET = SECRET;
  dbState.results = [];
  dbState.selectCalls = 0;
  grantsState.explicitSiteIds = [];
  grantsState.teamGatedSiteIds = [];
  grantsState.userTeamSiteIds = [];
  grantsState.calls = [];
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.HUB_API_SECRET;
});

describe("getUserByEmail — authentification", () => {
  it("répond 200 et les workspaces pour une signature valide", async () => {
    seedOwnerWithTwoSites();
    const reply = makeReply();

    await call(makeRequest(), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload.found).toBe(true);
    expect(reply.payload.user_email).toBe("client@exemple.fr");
    expect(reply.payload.workspaces).toHaveLength(2);
  });

  it("répond 401 et n'interroge PAS la base sur signature invalide", async () => {
    seedOwnerWithTwoSites();
    const reply = makeReply();

    await call(makeRequest({ signature: signGet("mauvais-secret", NOW) }), reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: "Invalid signature" });
    // Fail-closed : rien ne doit être lu, donc rien ne peut fuiter par un
    // canal auxiliaire (temps de réponse, message d'erreur).
    expect(dbState.selectCalls).toBe(0);
  });

  it("répond 401 quand la signature est absente", async () => {
    seedOwnerWithTwoSites();
    const reply = makeReply();
    const request = makeRequest();
    delete (request.headers as Record<string, unknown>)["x-veridian-hub-signature"];

    await call(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(dbState.selectCalls).toBe(0);
  });

  it("répond 401 quand l'horodatage est périmé, même signature correcte", async () => {
    seedOwnerWithTwoSites();
    const stale = NOW - 6 * 60 * 1000;
    const reply = makeReply();

    await call(makeRequest({ timestamp: String(stale), signature: signGet(SECRET, stale) }), reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: "Timestamp expired or invalid" });
    expect(dbState.selectCalls).toBe(0);
  });

  it("répond 500 sans rien lire quand le secret n'est pas configuré", async () => {
    delete process.env.HUB_API_SECRET;
    seedOwnerWithTwoSites();
    const reply = makeReply();

    await call(makeRequest(), reply);

    expect(reply.statusCode).toBe(500);
    expect(dbState.selectCalls).toBe(0);
  });
});

describe("getUserByEmail — validation", () => {
  it("répond 400 quand l'email manque", async () => {
    const reply = makeReply();
    const request = makeRequest();
    (request.query as { email?: string }).email = undefined;

    await call(request, reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: "missing_email" });
  });

  it("répond 400 sur une adresse malformée", async () => {
    const reply = makeReply();

    await call(makeRequest({ email: "pas-une-adresse" }), reply);

    expect(reply.statusCode).toBe(400);
    expect(reply.payload).toEqual({ error: "invalid_email" });
  });
});

describe("getUserByEmail — résultats", () => {
  it("répond 404 pour un utilisateur inconnu", async () => {
    dbState.results = [[]];
    const reply = makeReply();

    await call(makeRequest({ email: "inconnu@exemple.fr" }), reply);

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual({ found: false });
  });

  it("répond 404 pour un utilisateur sans aucune organisation", async () => {
    dbState.results = [[{ id: "user-1", email: "client@exemple.fr" }], []];
    const reply = makeReply();

    await call(makeRequest(), reply);

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual({ found: false });
  });

  it("décrit chaque site avec ce que le Hub attend", async () => {
    seedOwnerWithTwoSites();
    const reply = makeReply();

    await call(makeRequest(), reply);

    expect(reply.payload.workspaces[0]).toEqual({
      workspace_id: "1",
      workspace_name: "Site vitrine",
      role: "owner",
      plan: "free",
      status: "active",
      magic_link_capable: true,
      fallback_url: `${BRAND.appUrl}/1`,
    });
  });

  it("remonte le plan surchargé de l'organisation", async () => {
    seedOwnerWithTwoSites();
    dbState.results[2] = [{ id: "org-1", planOverride: "pro1m", customPlan: null }];
    const reply = makeReply();

    await call(makeRequest(), reply);

    expect(reply.payload.workspaces.every((w: { plan: string }) => w.plan === "pro1m")).toBe(true);
  });

  it("retombe sur le nom de domaine quand le site n'a pas de nom", async () => {
    seedOwnerWithTwoSites();
    dbState.results[3] = [{ siteId: 7, name: "", domain: "sansnom.fr", organizationId: "org-1" }];
    const reply = makeReply();

    await call(makeRequest(), reply);

    expect(reply.payload.workspaces[0].workspace_name).toBe("sansnom.fr");
  });

  it("trouve l'utilisateur quelle que soit la casse de l'adresse transmise", async () => {
    seedOwnerWithTwoSites();
    const reply = makeReply();

    await call(makeRequest({ email: "  Client@Exemple.FR  " }), reply);

    expect(reply.statusCode).toBe(200);
  });
});

describe("getUserByEmail — règle d'accès", () => {
  function seedRestrictedMember() {
    dbState.results = [
      [{ id: "user-2", email: "collab@exemple.fr" }],
      [{ id: "member-2", userId: "user-2", organizationId: "org-1", role: "member", hasRestrictedSiteAccess: true }],
      [{ id: "org-1", planOverride: null, customPlan: null }],
      [
        { siteId: 1, name: "Site vitrine", domain: "exemple.fr", organizationId: "org-1" },
        { siteId: 2, name: "Boutique", domain: "boutique.exemple.fr", organizationId: "org-1" },
      ],
    ];
  }

  it("ne renvoie à un membre restreint que les sites qui lui sont accordés", async () => {
    seedRestrictedMember();
    grantsState.explicitSiteIds = [2];
    const reply = makeReply();

    await call(makeRequest({ email: "collab@exemple.fr" }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.payload.workspaces).toHaveLength(1);
    expect(reply.payload.workspaces[0]).toMatchObject({ workspace_id: "2", role: "member" });
  });

  it("répond 404 à un membre restreint sans aucun accès", async () => {
    seedRestrictedMember();
    const reply = makeReply();

    await call(makeRequest({ email: "collab@exemple.fr" }), reply);

    expect(reply.statusCode).toBe(404);
    expect(reply.payload).toEqual({ found: false });
  });

  it("cache à un membre non restreint les sites réservés à une équipe dont il n'est pas", async () => {
    seedRestrictedMember();
    dbState.results[1] = [
      { id: "member-2", userId: "user-2", organizationId: "org-1", role: "member", hasRestrictedSiteAccess: false },
    ];
    grantsState.teamGatedSiteIds = [2];
    const reply = makeReply();

    await call(makeRequest({ email: "collab@exemple.fr" }), reply);

    expect(reply.payload.workspaces.map((w: { workspace_id: string }) => w.workspace_id)).toEqual(["1"]);
  });

  it("ne résout aucun grant pour un propriétaire et lui rend toute l'organisation", async () => {
    seedOwnerWithTwoSites();
    const reply = makeReply();

    await call(makeRequest(), reply);

    expect(grantsState.calls).toHaveLength(0);
    expect(reply.payload.workspaces).toHaveLength(2);
  });
});
