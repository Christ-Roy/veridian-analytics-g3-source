import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_TIMESTAMP_DRIFT_MS, hubApiSecret, verifyHubHmac } from "./hubHmac.js";

const SECRET = "hub-shared-secret-0123456789";
const NOW = 1_800_000_000_000;

/** Signature telle que le Hub la produit pour un GET (corps vide). */
function signGet(secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).digest("hex");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.HUB_API_SECRET;
});

describe("verifyHubHmac", () => {
  it("accepte une signature fraîche produite avec le secret partagé", () => {
    const ts = String(NOW);
    expect(verifyHubHmac(SECRET, ts, "", signGet(SECRET, NOW))).toEqual({ ok: true });
  });

  it("reproduit exactement le calcul de `signGet` du Hub", () => {
    // Copie littérale de veridian-hub/lib/sync/discovery.ts — si l'une des deux
    // dérive, ce test tombe avant que la production ne le fasse.
    const timestamp = Date.now().toString();
    const signature = createHmac("sha256", SECRET).update(`${timestamp}.`).digest("hex");

    expect(verifyHubHmac(SECRET, timestamp, "", signature)).toEqual({ ok: true });
  });

  it("refuse quand le serveur n'a pas de secret configuré", () => {
    expect(verifyHubHmac(undefined, String(NOW), "", signGet(SECRET, NOW))).toEqual({
      ok: false,
      reason: "missing_secret",
    });
  });

  it("refuse une requête sans signature", () => {
    expect(verifyHubHmac(SECRET, String(NOW), "", undefined)).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("refuse une signature produite avec un autre secret", () => {
    expect(verifyHubHmac(SECRET, String(NOW), "", signGet("un-autre-secret", NOW))).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("refuse une signature qui n'est pas de l'hexadécimal de la bonne longueur", () => {
    expect(verifyHubHmac(SECRET, String(NOW), "", "deadbeef")).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    expect(verifyHubHmac(SECRET, String(NOW), "", "pas-du-tout-hexadecimal")).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("refuse une signature valide rejouée sur un autre corps", () => {
    // La signature couvre le corps : celle d'un GET ne vaut pas pour un POST.
    expect(verifyHubHmac(SECRET, String(NOW), '{"email":"x@y.z"}', signGet(SECRET, NOW))).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it.each([
    ["absent", undefined],
    ["vide", ""],
    ["non numérique", "hier"],
    ["décimal", "1800000000000.5"],
    ["démesuré", "18000000000000000000"],
  ])("refuse un horodatage %s", (_label, timestamp) => {
    expect(verifyHubHmac(SECRET, timestamp, "", signGet(SECRET, NOW))).toEqual({
      ok: false,
      reason: "invalid_timestamp",
    });
  });

  it("refuse un horodatage périmé au-delà de la fenêtre anti-rejeu", () => {
    const stale = NOW - HUB_TIMESTAMP_DRIFT_MS - 1_000;
    expect(verifyHubHmac(SECRET, String(stale), "", signGet(SECRET, stale))).toEqual({
      ok: false,
      reason: "timestamp_drift",
    });
  });

  it("refuse un horodatage trop avancé dans le futur", () => {
    const ahead = NOW + HUB_TIMESTAMP_DRIFT_MS + 1_000;
    expect(verifyHubHmac(SECRET, String(ahead), "", signGet(SECRET, ahead))).toEqual({
      ok: false,
      reason: "timestamp_drift",
    });
  });

  it("tolère la dérive d'horloge à l'intérieur de la fenêtre, dans les deux sens", () => {
    const early = NOW - HUB_TIMESTAMP_DRIFT_MS + 1_000;
    const late = NOW + HUB_TIMESTAMP_DRIFT_MS - 1_000;
    expect(verifyHubHmac(SECRET, String(early), "", signGet(SECRET, early)).ok).toBe(true);
    expect(verifyHubHmac(SECRET, String(late), "", signGet(SECRET, late)).ok).toBe(true);
  });
});

describe("hubApiSecret", () => {
  it("lit HUB_API_SECRET à l'appel", () => {
    expect(hubApiSecret()).toBeUndefined();
    process.env.HUB_API_SECRET = SECRET;
    expect(hubApiSecret()).toBe(SECRET);
  });

  it("traite un secret vide comme absent", () => {
    process.env.HUB_API_SECRET = "";
    expect(hubApiSecret()).toBeUndefined();
  });
});
