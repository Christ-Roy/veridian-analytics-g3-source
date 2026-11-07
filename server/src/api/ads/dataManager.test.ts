import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdsIngestError,
  buildIngestPayload,
  conversionActionId,
  formatEventTimestamp,
  getAccessToken,
  ingestConversions,
  pickAdIdentifiers,
  resetTokenCacheForTests,
  type AdsCredentials,
  type AdsDestination,
  type ConversionEvent,
} from "./dataManager.js";

const credentials: AdsCredentials = {
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "refresh",
};

const destination: AdsDestination = {
  operatingAccountId: "2568911678",
  loginAccountId: "6437191896",
  conversionActionId: "7738430146",
};

function evenement(overrides: Partial<ConversionEvent> = {}): ConversionEvent {
  return {
    transactionId: "order_paid:cmd-1",
    gclid: "EAIaIQobChMI_CaSeSensible",
    occurredAt: "2026-08-29T09:00:00.123Z",
    value: 42.5,
    currency: "EUR",
    ...overrides,
  };
}

/** Réponse `fetch` minimale, pour n'avoir à simuler que ce qui est lu. */
function reponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const jetonOk = reponse(200, { access_token: "jeton", expires_in: 3600 });

beforeEach(() => {
  resetTokenCacheForTests();
});

describe("formatEventTimestamp", () => {
  it("normalise en RFC 3339 UTC sans millisecondes", () => {
    expect(formatEventTimestamp("2026-08-29T09:00:00.123Z")).toBe("2026-08-29T09:00:00Z");
  });

  it("ramène un décalage horaire à UTC", () => {
    expect(formatEventTimestamp("2026-08-29T11:00:00+02:00")).toBe("2026-08-29T09:00:00Z");
  });

  it("refuse une date illisible ICI, sans la faire refuser par Google", () => {
    // Google répond 400 sur ce cas ; le détecter en amont rend l'erreur lisible
    // et évite un aller-retour réseau pour rien.
    expect(() => formatEventTimestamp("pas-une-date")).toThrow(AdsIngestError);
    try {
      formatEventTimestamp("pas-une-date");
    } catch (err) {
      expect((err as AdsIngestError).retryable).toBe(false);
    }
  });
});

describe("conversionActionId", () => {
  it("extrait l'id numérique d'un resource name complet", () => {
    expect(conversionActionId("customers/2568911678/conversionActions/7738430146")).toBe(
      "7738430146",
    );
  });

  it("laisse passer un id déjà nu", () => {
    expect(conversionActionId("7738430146")).toBe("7738430146");
  });

  it("refuse un label de conversion, qui n'est pas un id", () => {
    // Piège réel : le compte ASD expose « AW-18413758700/cL48CMKl_OkcEOzRrsxE »,
    // qui sert au tag du site et n'a rien à faire ici.
    expect(() => conversionActionId("AW-18413758700/cL48CMKl_OkcEOzRrsxE")).toThrow(
      AdsIngestError,
    );
  });
});

describe("pickAdIdentifiers", () => {
  it("préfère le gclid, le plus précis", () => {
    expect(pickAdIdentifiers(evenement({ gclid: "A", gbraid: "B", wbraid: "C" }))).toEqual({
      gclid: "A",
    });
  });

  it("retombe sur gbraid puis wbraid", () => {
    expect(pickAdIdentifiers(evenement({ gclid: null, gbraid: "B", wbraid: "C" }))).toEqual({
      gbraid: "B",
    });
    expect(pickAdIdentifiers(evenement({ gclid: null, gbraid: null, wbraid: "C" }))).toEqual({
      wbraid: "C",
    });
  });

  it("n'envoie jamais deux identifiants à la fois", () => {
    // L'API les accepte ensemble, mais deux identifiants décrivent deux clics
    // possibles : laisser Google arbitrer rendrait l'attribution inexplicable.
    const ids = pickAdIdentifiers(evenement({ gclid: "A", gbraid: "B" }));
    expect(Object.keys(ids)).toHaveLength(1);
  });

  it("refuse une conversion sans aucun identifiant de clic", () => {
    expect(() => pickAdIdentifiers(evenement({ gclid: null }))).toThrow(AdsIngestError);
  });
});

describe("buildIngestPayload", () => {
  it("préserve la casse exacte du gclid", () => {
    // La casse est significative pour Google. Le tracker la conserve déjà ;
    // ce test interdit qu'on la perde au dernier moment.
    const payload = buildIngestPayload(destination, [evenement()]) as any;
    expect(payload.events[0].adIdentifiers.gclid).toBe("EAIaIQobChMI_CaSeSensible");
  });

  it("place l'action de conversion en productDestinationId, jamais en resource name", () => {
    const payload = buildIngestPayload(
      { ...destination, conversionActionId: "customers/2568911678/conversionActions/7738430146" },
      [evenement()],
    ) as any;
    expect(payload.destinations[0].productDestinationId).toBe("7738430146");
  });

  it("omet loginAccount quand il n'y a pas de compte administrateur", () => {
    const payload = buildIngestPayload(
      { operatingAccountId: "123", conversionActionId: "456" },
      [evenement()],
    ) as any;
    expect(payload.destinations[0].loginAccount).toBeUndefined();
  });

  it("transporte le consentement tel quel quand il est fourni", () => {
    const payload = buildIngestPayload(destination, [
      evenement({
        consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" },
      }),
    ]) as any;
    expect(payload.events[0].consent).toEqual({
      adUserData: "CONSENT_GRANTED",
      adPersonalization: "CONSENT_GRANTED",
    });
  });

  it("n'invente pas de consentement quand il est absent", () => {
    const payload = buildIngestPayload(destination, [evenement()]) as any;
    expect(payload.events[0].consent).toBeUndefined();
  });

  it("porte validateOnly, qui laisse le compte intact", () => {
    const payload = buildIngestPayload(destination, [evenement()], true) as any;
    expect(payload.validateOnly).toBe(true);
  });
});

describe("getAccessToken", () => {
  it("ne redemande pas un jeton encore valide", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jetonOk);
    await getAccessToken(credentials, fetchImpl as any);
    await getAccessToken(credentials, fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("en redemande un lorsque l'échéance approche", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jetonOk);
    let maintenant = 0;
    await getAccessToken(credentials, fetchImpl as any, () => maintenant);
    // Au-delà d'une heure moins la marge de cinq minutes, le jeton est périmé.
    maintenant = 3600_000;
    await getAccessToken(credentials, fetchImpl as any, () => maintenant);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("traite un refus OAuth comme définitif, pas comme à réessayer", async () => {
    // Un scope absent ou un jeton révoqué ne se répare pas en insistant.
    const fetchImpl = vi.fn().mockResolvedValue(reponse(400, { error: "invalid_grant" }));
    await expect(getAccessToken(credentials, fetchImpl as any)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("traite une coupure réseau comme à réessayer", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(getAccessToken(credentials, fetchImpl as any)).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe("ingestConversions", () => {
  it("n'appelle pas le réseau pour un lot vide", async () => {
    const fetchImpl = vi.fn();
    const res = await ingestConversions(credentials, destination, [], { fetchImpl: fetchImpl as any });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.eventCount).toBe(0);
  });

  it("rapporte le requestId rendu par Google", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jetonOk)
      .mockResolvedValueOnce(reponse(200, { requestId: "v-1234" }));
    const res = await ingestConversions(credentials, destination, [evenement()], {
      fetchImpl: fetchImpl as any,
    });
    expect(res.requestId).toBe("v-1234");
    expect(res.eventCount).toBe(1);
  });

  it("envoie le jeton en en-tête, et AUCUN developer-token", async () => {
    // Les en-têtes de l'ancienne API sont ignorés ici ; les envoyer quand même
    // laisserait croire qu'ils servent à quelque chose.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jetonOk)
      .mockResolvedValueOnce(reponse(200, { requestId: "v-1" }));
    await ingestConversions(credentials, destination, [evenement()], {
      fetchImpl: fetchImpl as any,
    });
    const headers = fetchImpl.mock.calls[1][1].headers;
    expect(headers.Authorization).toBe("Bearer jeton");
    expect(headers["developer-token"]).toBeUndefined();
    expect(headers["login-customer-id"]).toBeUndefined();
  });

  it.each([
    [400, false, "message mal formé"],
    [403, false, "compte hors périmètre"],
    [404, false, "action de conversion inexistante"],
    [429, true, "trop de requêtes"],
    [500, true, "panne côté Google"],
    [503, true, "service indisponible"],
  ])("classe le %i comme retryable=%s (%s)", async (status, retryable) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jetonOk)
      .mockResolvedValueOnce(reponse(status as number, { error: { status: "TEST" } }));
    await expect(
      ingestConversions(credentials, destination, [evenement()], { fetchImpl: fetchImpl as any }),
    ).rejects.toMatchObject({ retryable, status });
  });

  it("remonte une coupure réseau comme à réessayer", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jetonOk)
      .mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      ingestConversions(credentials, destination, [evenement()], { fetchImpl: fetchImpl as any }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("groupe plusieurs conversions en un seul appel", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jetonOk)
      .mockResolvedValueOnce(reponse(200, { requestId: "v-1" }));
    const res = await ingestConversions(
      credentials,
      destination,
      [evenement(), evenement({ transactionId: "order_paid:cmd-2" })],
      { fetchImpl: fetchImpl as any },
    );
    expect(res.eventCount).toBe(2);
    // Un appel OAuth, un appel d'ingestion : pas un par conversion.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

/**
 * Les réponses que Google rend hors du scénario prévu. Toutes ont ceci de
 * commun : elles portent un code HTTP qui a l'air normal, ou un corps qui n'a
 * pas la forme annoncée. C'est exactement la famille de défauts que le module
 * traque ailleurs — un succès qui n'en est pas un.
 */
describe("dataManager — les réponses hors contrat", () => {
  it("🔴 refuse un 200 OAuth qui ne porte pas de jeton, au lieu d'en fabriquer un vide", async () => {
    // Vu en vrai sur les points d'entrée Google : un 200 dont le corps est une
    // page d'erreur ou un `{"error":"..."}`. Sans ce contrôle, `access_token`
    // vaut `undefined`, part en `Authorization: Bearer undefined`, et
    // l'ingestion échoue plus loin sur un 401 qui accuse le mauvais coupable.
    // Le diagnostic se ferait alors sur les droits du compte client, à des
    // kilomètres de la vraie cause.
    const fetchImpl = vi.fn().mockResolvedValue(reponse(200, { scope: "adwords", token_type: "Bearer" }));
    await expect(getAccessToken(credentials, fetchImpl as any)).rejects.toThrow(AdsIngestError);
    await expect(getAccessToken(credentials, fetchImpl as any)).rejects.toMatchObject({
      // Définitif : un point d'entrée OAuth qui rend ça ne se répare pas en
      // réessayant, et insister brûlerait le budget de tentatives.
      retryable: false,
    });
  });

  it("ne met pas en cache un jeton refusé", async () => {
    // Le corollaire du test précédent : si l'échec avait été mis en cache, tout
    // envoi ultérieur du processus échouerait sans jamais redemander de jeton.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reponse(200, {}))
      .mockResolvedValueOnce(jetonOk);
    await expect(getAccessToken(credentials, fetchImpl as any)).rejects.toThrow();
    expect(await getAccessToken(credentials, fetchImpl as any)).toBe("jeton");
  });

  it("prend une heure par défaut quand Google omet expires_in", async () => {
    // Sans le repli, l'échéance vaudrait NaN. Toute comparaison avec NaN étant
    // fausse, le cache serait contourné à CHAQUE envoi : un aller-retour OAuth
    // par lot, et le quota de jetons qui se remplit sans raison visible.
    const fetchImpl = vi.fn().mockResolvedValue(reponse(200, { access_token: "jeton" }));
    let maintenant = 0;
    await getAccessToken(credentials, fetchImpl as any, () => maintenant);
    maintenant = 60_000; // une minute plus tard, le jeton doit encore servir
    await getAccessToken(credentials, fetchImpl as any, () => maintenant);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("🔴 survit à un corps d'erreur qui n'est pas du JSON", async () => {
    // Le cas concret : un répartiteur de charge ou un proxy qui rend une page
    // HTML sur un 502. Sans le `try` autour du `JSON.parse`, l'analyse du corps
    // lève, et l'exception qui remonte n'est plus une `AdsIngestError` : elle
    // perd `retryable` et `status`. Le drain la traiterait alors par son défaut
    // « transitoire » — correct ici par chance, faux le jour où le corps
    // illisible accompagne un 400. Et le statut HTTP disparaîtrait du journal.
    const html = "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>";
    const fetchImpl = vi.fn().mockResolvedValueOnce(jetonOk).mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => html,
      json: async () => JSON.parse(html),
    } as unknown as Response);

    const erreur = await ingestConversions(credentials, destination, [evenement()], {
      fetchImpl: fetchImpl as any,
    }).catch(e => e);

    expect(erreur).toBeInstanceOf(AdsIngestError);
    expect(erreur).toMatchObject({ status: 502, retryable: true, reason: undefined });
    expect(erreur.message).toContain("502");
    expect(erreur.message).toContain("Bad Gateway");
  });

  it("accepte un succès sans requestId plutôt que d'inventer une valeur", async () => {
    // Le `requestId` est écrit en base pour retrouver un envoi chez Google. Il
    // n'est pas garanti : le rendre obligatoire ferait échouer, et donc
    // REJOUER, un envoi qui a pourtant abouti. Mieux vaut `null` qu'un renvoi.
    const fetchImpl = vi.fn().mockResolvedValueOnce(jetonOk).mockResolvedValueOnce(reponse(200, {}));
    const res = await ingestConversions(credentials, destination, [evenement()], {
      fetchImpl: fetchImpl as any,
    });
    expect(res).toEqual({ requestId: null, eventCount: 1, validateOnly: false });
  });
});
