/**
 * Contrat : le MEME visiteur, vu par le suivi (createBasePayload) puis par
 * l'ingestion des relectures, obtient le MEME user_id et la MEME session.
 *
 * Constat du 01/10/2026 sur le site 3 : 277 sessions, 291 relectures, zero
 * recouvrement, has_replay = 0 partout. Le suivi hachait l'anonymous_id du
 * navigateur, la relecture hachait IP + User-Agent : deux identites, donc deux
 * sessions. Ici tout est reel (hachage, cle de session) sauf Redis, remplace
 * par une Map, et ClickHouse, dont on lit les lignes inserees.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordSessionReplayRequest } from "../../types/sessionReplay.js";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  sessions: new Map<string, string>(),
}));

vi.mock("../../db/clickhouse/clickhouse.js", () => ({
  clickhouse: { insert: mocks.insert, query: vi.fn() },
}));

// Redis remplace par une Map : meme contrat "lire ou creer", sans reseau.
vi.mock("../../db/redis/redis.js", () => ({
  sessionRedis: { quit: vi.fn() },
  sessionGetOrCreate: async (key: string, candidate: string) => {
    const existing = mocks.sessions.get(key);
    if (existing) return existing;
    mocks.sessions.set(key, candidate);
    return candidate;
  },
}));

// L'empreinte IP + UA passe par le rattachement "collant" (Redis) : on le rend
// transparent, ce qui est exactement ce qu'il fait pour un visiteur inconnu.
vi.mock("../userId/stickyUserId.js", () => ({
  resolveStickyUserId: async ({ rawUserId }: { rawUserId: string }) => rawUserId,
}));

vi.mock("../../lib/const.js", () => ({ SECRET: "secret-de-test" }));
vi.mock("../../db/geolocation/asn.js", () => ({ lookupAsn: () => undefined }));
vi.mock("../../lib/siteConfig.js", () => ({ siteConfig: { getConfig: async () => ({ saltUserIds: false }) } }));
vi.mock("../storage/r2StorageService.js", () => ({ r2Storage: { isEnabled: () => false } }));

import { createBasePayload } from "../tracker/utils.js";
import { sessionsService } from "../sessions/sessionsService.js";
import { userIdService } from "../userId/userIdService.js";
import { SessionReplayIngestService } from "./sessionReplayIngestService.js";

const SITE_ID = 3;
const IP = "203.0.113.7";
const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36";
const VISITOR_ID = "6f1c0c1e-3f55-4b0a-9a53-0e2f6b7d9a10";

async function trackedVisit(opts: { anonymousId?: string; ip?: string; ua?: string; salted?: boolean; at?: Date }) {
  const ip = opts.ip ?? IP;
  const ua = opts.ua ?? UA;
  const payload = await createBasePayload({
    payload: { type: "pageview", anonymous_id: opts.anonymousId, user_id: undefined },
    site: { siteId: SITE_ID, saltUserIds: opts.salted ?? false, trackIp: false },
    ipAddress: ip,
    userAgent: ua,
    receivedAt: opts.at ?? new Date("2026-10-01T10:00:00Z"),
    lookupAsn: () => undefined,
  } as any);
  const { sessionId } = await sessionsService.updateSession({
    userId: payload.userId,
    identifiedUserId: payload.identifiedUserId,
    siteId: SITE_ID,
  });
  return { userId: payload.userId, sessionId };
}

async function replayBatch(opts: { anonymousId?: string; ip?: string; ua?: string; userId?: string; salted?: boolean }) {
  const request: RecordSessionReplayRequest = {
    userId: opts.userId ?? "",
    ...(opts.anonymousId ? { anonymous_id: opts.anonymousId } : {}),
    events: [{ type: 2, data: { node: 1 }, timestamp: 1_790_000_000_000 }],
  };
  await new SessionReplayIngestService().recordEvents(SITE_ID, request, {
    ipAddress: opts.ip ?? IP,
    userAgent: opts.ua ?? UA,
    origin: "https://site-c.fr",
    referrer: "",
    saltUserIds: opts.salted ?? false,
  });
  const rows = mocks.insert.mock.calls.flatMap(call => call[0].values).filter((v: any) => v.event_type !== undefined);
  return rows[rows.length - 1] as { user_id: string; session_id: string };
}

describe("identite du visiteur : suivi et relecture", () => {
  beforeEach(() => {
    mocks.insert.mockReset();
    mocks.insert.mockResolvedValue(undefined);
    mocks.sessions.clear();
  });

  it("le meme visiteur obtient le meme user_id et la meme session dans le suivi et la relecture", async () => {
    const visit = await trackedVisit({ anonymousId: VISITOR_ID });
    const replay = await replayBatch({ anonymousId: VISITOR_ID });

    expect(replay.user_id).toBe(visit.userId);
    expect(replay.session_id).toBe(visit.sessionId);
  });

  it("tient meme quand l'IP et le navigateur different entre les deux (wifi vers 4G, UA reduit)", async () => {
    const visit = await trackedVisit({ anonymousId: VISITOR_ID });
    const replay = await replayBatch({ anonymousId: VISITOR_ID, ip: "198.51.100.99", ua: "Autre/2.0" });

    expect(replay.session_id).toBe(visit.sessionId);
  });

  it("tient sur un site qui sale les identifiants", async () => {
    const at = new Date();
    const visit = await trackedVisit({ anonymousId: VISITOR_ID, salted: true, at });
    const replay = await replayBatch({ anonymousId: VISITOR_ID, salted: true });

    expect(replay.user_id).toBe(visit.userId);
    expect(replay.session_id).toBe(visit.sessionId);
  });

  it("deux visiteurs derriere la meme IP et le meme navigateur restent deux sessions", async () => {
    const a = await trackedVisit({ anonymousId: VISITOR_ID });
    const b = await trackedVisit({ anonymousId: "autre-visiteur" });
    const replayA = await replayBatch({ anonymousId: VISITOR_ID });
    const replayB = await replayBatch({ anonymousId: "autre-visiteur" });

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(replayA.session_id).toBe(a.sessionId);
    expect(replayB.session_id).toBe(b.sessionId);
  });

  it("retro-compatibilite : un lot sans anonymous_id retombe sur l'empreinte IP + navigateur", async () => {
    const fingerprint = await userIdService.generateUserId(IP, UA, SITE_ID, { saltUserIds: false });
    const visit = await trackedVisit({}); // ancien script : le suivi aussi retombe sur l'empreinte
    const replay = await replayBatch({});

    expect(replay.user_id).toBe(fingerprint);
    expect(replay.user_id).toBe(visit.userId);
    expect(replay.session_id).toBe(visit.sessionId);
  });

  it("le suivi produit EXACTEMENT les memes user_id qu'avant (valeurs figees)", async () => {
    // Calcul d'avant la correction, fige : sha256(`${siteId}:${anonymousId}:`) tronque a 12.
    // Valeur calculee HORS du code (python3 hashlib), pas par lui.
    const { createHash } = await import("crypto");
    expect((await trackedVisit({ anonymousId: VISITOR_ID })).userId).toBe("911ffae59955");

    // Empreinte : sha256(ip + ua) tronque a 12, sans sel.
    const empreinte = createHash("sha256").update(IP + UA).digest("hex").substring(0, 12);
    expect((await trackedVisit({})).userId).toBe(empreinte);
  });
});
