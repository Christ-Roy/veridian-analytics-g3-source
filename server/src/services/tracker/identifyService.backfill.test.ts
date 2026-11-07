import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Le rattachement rétroactif doit être tenté DEUX fois : une fois tout de suite,
 * une fois après le vidage de la file d'ingestion.
 *
 * Sans le second passage, le défaut mesuré en production le 2026-08-18 revient :
 * la personne s'identifie juste après avoir navigué, les pages vues de cette
 * visite sont encore dans la file (écrite par lots toutes les secondes), et la
 * mutation ClickHouse ne trouve rien à rattacher. Elle réussit — sans rien
 * faire. Le parcours qui mène à la connexion reste anonyme pour toujours.
 *
 * Ce test échoue si quelqu'un retire le passage différé en le croyant redondant.
 */

const commandMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../../db/clickhouse/clickhouse.js", () => ({
  clickhouse: { command: (...args: unknown[]) => commandMock(...args) },
}));
vi.mock("../../lib/logger/logger.js", () => ({
  createServiceLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// Le module tire toute la chaîne d'ingestion (identité → géolocalisation → base
// ASN sur disque). On ne teste ici que la requête de rattachement : le reste est
// remplacé pour que le test reste rapide et sans dépendance externe.
vi.mock("../../db/postgres/postgres.js", () => ({ db: {} }));
vi.mock("../userId/userIdService.js", () => ({ userIdService: {} }));
vi.mock("../../lib/siteConfig.js", () => ({ siteConfig: {} }));
vi.mock("./resolveClientIp.js", () => ({ resolveClientIp: () => "127.0.0.1" }));

const TABLES = 3; // events, session_replay_events, session_replay_metadata

describe("rattachement rétroactif de l'identité", () => {
  beforeEach(() => {
    commandMock.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("n'écrase jamais une identité déjà posée", async () => {
    const { backfillIdentifiedUserId } = await import("./identifyService.js");
    await backfillIdentifiedUserId(1, "empreinte-abc", "cliente@exemple.fr");

    // La clause qui rend le second passage inoffensif : on ne touche qu'aux
    // événements encore anonymes.
    for (const appel of commandMock.mock.calls) {
      expect(appel[0].query).toContain("identified_user_id = ''");
    }
  });

  it("cible les trois tables qui portent une identité", async () => {
    const { backfillIdentifiedUserId } = await import("./identifyService.js");
    await backfillIdentifiedUserId(1, "empreinte-abc", "cliente@exemple.fr");

    expect(commandMock).toHaveBeenCalledTimes(TABLES);
    const requetes = commandMock.mock.calls.map((c) => c[0].query as string);
    expect(requetes.some((q) => q.includes("ALTER TABLE events"))).toBe(true);
    expect(requetes.some((q) => q.includes("ALTER TABLE session_replay_events"))).toBe(true);
    // session_replay_metadata n'a pas de colonne `timestamp` mais `start_time` :
    // s'y tromper renvoie une erreur ClickHouse 47 (UNKNOWN_IDENTIFIER).
    const meta = requetes.find((q) => q.includes("ALTER TABLE session_replay_metadata"));
    expect(meta).toContain("start_time");
    expect(meta).not.toContain("timestamp >=");
  });

  it("borne la fenêtre pour ne pas balayer toutes les partitions", async () => {
    const { backfillIdentifiedUserId } = await import("./identifyService.js");
    await backfillIdentifiedUserId(1, "empreinte-abc", "cliente@exemple.fr");
    for (const appel of commandMock.mock.calls) {
      expect(appel[0].query).toContain("INTERVAL {days: UInt16} DAY");
    }
    // days: null est réservé à une action d'administration explicite.
    commandMock.mockClear();
    await backfillIdentifiedUserId(1, "empreinte-abc", "cliente@exemple.fr", null);
    for (const appel of commandMock.mock.calls) {
      expect(appel[0].query).not.toContain("INTERVAL");
    }
  });
});
