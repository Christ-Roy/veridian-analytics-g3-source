/**
 * Ce que ces tests protègent, et que rien d'autre ne peut voir.
 *
 * Les fautes de cette brique ne rendent pas d'erreur : elles rendent des
 * CHIFFRES FAUX qui ont l'air complets. Une requête sans `segments.date`
 * sélectionné agrège toute la période sur une ligne, et l'import écrit alors un
 * mois de dépense sur un seul jour. Un `searchStream` analysé comme un `search`
 * lit zéro ligne sans lever. Un total qui additionne deux devises rend un nombre
 * parfaitement plausible et parfaitement faux.
 *
 * Le réseau est injecté : ces tests prouvent l'analyse, jamais Google. La preuve
 * réseau réelle vit à part, derrière un drapeau, comme pour `dataManager`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AdsCoutsError,
  construireRequeteCouts,
  identifiantsDepuisEnv,
  jourUtc,
  lireCoutsCampagnes,
} from "./couts.js";

const IDS = {
  clientId: "ci",
  clientSecret: "cs",
  refreshToken: "rt",
  loginCustomerId: "6437191896",
  developerToken: "dt",
};

function reponse(corps: unknown, statut = 200, json = true): Response {
  return {
    ok: statut >= 200 && statut < 300,
    status: statut,
    json: async () => {
      if (!json) throw new Error("pas du JSON");
      return corps;
    },
    text: async () => JSON.stringify(corps),
  } as unknown as Response;
}

const OAUTH_OK = reponse({ access_token: "jeton" });

describe("construireRequeteCouts", () => {
  it("SÉLECTIONNE segments.date, pas seulement le filtre", () => {
    // 🔴 LE test de ce fichier. Sans la sélection, Google agrège toute la
    // période sur une ligne par campagne et l'import écrit un mois de dépense
    // sur un seul jour — des données fausses qui ont l'air complètes.
    const q = construireRequeteCouts("2026-09-01", "2026-09-14");
    expect(q).toContain("segments.date,");
    expect(q).toContain("BETWEEN '2026-09-01' AND '2026-09-14'");
  });

  it("lit les campagnes et les métriques qui servent au ROAS", () => {
    const q = construireRequeteCouts("2026-09-01", "2026-09-02");
    for (const champ of [
      "campaign.id",
      "campaign.name",
      "customer.currency_code",
      "metrics.cost_micros",
      "metrics.clicks",
      "metrics.conversions_value",
    ]) {
      expect(q).toContain(champ);
    }
  });
});

describe("jourUtc", () => {
  it("rend le format que Google exige, en UTC", () => {
    expect(jourUtc(new Date("2026-09-04T23:30:00Z"))).toBe("2026-09-04");
    // Un fuseau local en avance changerait le jour : c'est bien UTC qui décide.
    expect(jourUtc(new Date("2026-09-04T00:10:00Z"))).toBe("2026-09-04");
  });
});

describe("identifiantsDepuisEnv", () => {
  it("exige les CINQ variables, developer-token compris", () => {
    // `developer-token` et `login-customer-id` sont propres à l'API de LECTURE.
    // L'API d'envoi les refuse ; les oublier ici rend un 403 qu'on va chercher
    // du côté des droits sur le compte, au mauvais endroit.
    const complet = {
      GOOGLE_ADS_OAUTH_CLIENT_ID: "a",
      GOOGLE_ADS_OAUTH_CLIENT_SECRET: "b",
      GOOGLE_ADS_REFRESH_TOKEN: "c",
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: "d",
      GOOGLE_ADS_DEVELOPER_TOKEN: "e",
    };
    expect(identifiantsDepuisEnv(complet as NodeJS.ProcessEnv)).not.toBeNull();
    for (const manquante of Object.keys(complet)) {
      const partiel = { ...complet } as Record<string, string>;
      delete partiel[manquante];
      expect(identifiantsDepuisEnv(partiel as NodeJS.ProcessEnv), `sans ${manquante}`).toBeNull();
    }
  });
});

describe("lireCoutsCampagnes", () => {
  it("analyse la forme réelle de searchStream : un TABLEAU de lots", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(OAUTH_OK)
      .mockResolvedValueOnce(
        reponse([
          {
            results: [
              {
                campaign: { id: "123", name: "Marque" },
                customer: { currencyCode: "EUR" },
                segments: { date: "2026-09-01" },
                metrics: { costMicros: "1500000", clicks: "12", impressions: "300", conversions: "2", conversionsValue: "80" },
              },
            ],
          },
        ])
      );
    const lignes = await lireCoutsCampagnes("6336440750", "2026-09-01", "2026-09-01", IDS, f as unknown as typeof fetch);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({
      date: "2026-09-01",
      campaignId: "123",
      currency: "EUR",
      costMicros: 1500000,
      clicks: 12,
      conversionsValue: 80,
    });
  });

  it("REFUSE un objet là où searchStream rend un tableau", async () => {
    // C'est la forme que rend `search`, l'autre point d'entrée. La confondre
    // ferait lire zéro ligne sans la moindre erreur — un import « réussi » et
    // vide, indistinguable d'un compte qui ne dépense pas.
    const f = vi.fn().mockResolvedValueOnce(OAUTH_OK).mockResolvedValueOnce(reponse({ results: [] }));
    await expect(
      lireCoutsCampagnes("1", "2026-09-01", "2026-09-01", IDS, f as unknown as typeof fetch)
    ).rejects.toThrow(AdsCoutsError);
  });

  it("écarte une ligne sans date plutôt que d'inventer une clé", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(OAUTH_OK)
      .mockResolvedValueOnce(
        reponse([{ results: [{ campaign: { id: "1", name: "X" }, metrics: { costMicros: "1" } }] }])
      );
    const lignes = await lireCoutsCampagnes("1", "2026-09-01", "2026-09-01", IDS, f as unknown as typeof fetch);
    expect(lignes).toHaveLength(0);
  });

  it("distingue ce qui vaut d'être réessayé de ce qui ne le vaut pas", async () => {
    const cas: Array<[number, boolean]> = [
      [403, false], // scope ou périmètre : réessayer n'y changera rien
      [404, false], // version d'API périmée
      [429, true], // quota
      [500, true], // panne passagère
    ];
    for (const [statut, reessayable] of cas) {
      const f = vi.fn().mockResolvedValueOnce(OAUTH_OK).mockResolvedValueOnce(reponse({ e: 1 }, statut));
      await expect(
        lireCoutsCampagnes("1", "2026-09-01", "2026-09-01", IDS, f as unknown as typeof fetch)
      ).rejects.toMatchObject({ reessayable, statut });
    }
  });

  it("nomme une réponse non-JSON au lieu de lever une erreur d'analyse nue", async () => {
    // Une version d'API périmée rend du HTML. Sans ce cas, l'appelant reçoit un
    // « Unexpected token < » qui ne dit rien de la cause.
    const f = vi.fn().mockResolvedValueOnce(OAUTH_OK).mockResolvedValueOnce(reponse(null, 200, false));
    await expect(
      lireCoutsCampagnes("1", "2026-09-01", "2026-09-01", IDS, f as unknown as typeof fetch)
    ).rejects.toThrow(/autre chose que du JSON/);
  });

  it("un OAuth refusé en 4xx n'est pas réessayable", async () => {
    const f = vi.fn().mockResolvedValueOnce(reponse({ error: "invalid_grant" }, 400));
    await expect(
      lireCoutsCampagnes("1", "2026-09-01", "2026-09-01", IDS, f as unknown as typeof fetch)
    ).rejects.toMatchObject({ reessayable: false });
  });
});
