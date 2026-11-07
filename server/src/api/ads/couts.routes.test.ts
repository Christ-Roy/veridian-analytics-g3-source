/**
 * La validation de période, et pourquoi elle REFUSE au lieu de corriger.
 *
 * Une plage inversée ou une date illisible corrigée en silence rendrait un
 * total sur une période que l'utilisateur n'a pas demandée : un chiffre juste
 * pour la mauvaise question, ce qui est pire qu'une erreur, parce que rien ne
 * le signale et qu'on prend une décision dessus.
 */
import { describe, expect, it } from "vitest";
import { validerPeriode } from "./routes.js";

describe("validerPeriode", () => {
  it("accepte une plage bien formée", () => {
    expect(validerPeriode("2026-08-01", "2026-09-01")).toEqual({
      ok: true,
      debut: "2026-08-01",
      fin: "2026-09-01",
    });
  });

  it("accepte une plage d'un seul jour", () => {
    // Le cas limite le plus courant : « combien ai-je dépensé hier ».
    expect(validerPeriode("2026-09-01", "2026-09-01").ok).toBe(true);
  });

  it("REFUSE une plage inversée au lieu de l'échanger", () => {
    const r = validerPeriode("2026-09-01", "2026-08-01");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/postérieure/);
  });

  it("refuse un format qui n'est pas AAAA-MM-JJ", () => {
    for (const mauvais of ["01/09/2026", "2026-9-1", "hier", "", "2026-09-01T00:00:00Z"]) {
      expect(validerPeriode(mauvais, "2026-09-02").ok, `pour « ${mauvais} »`).toBe(false);
    }
  });

  it("refuse une borne absente", () => {
    expect(validerPeriode(undefined, "2026-09-02").ok).toBe(false);
    expect(validerPeriode("2026-09-01", undefined).ok).toBe(false);
    expect(validerPeriode(null, null).ok).toBe(false);
  });

  it("refuse autre chose qu'une chaîne", () => {
    // Une requête HTTP peut porter `?start_date=a&start_date=b`, que Fastify
    // rend comme un TABLEAU. Sans ce cas, le motif serait appliqué à un objet.
    expect(validerPeriode(["2026-09-01"], "2026-09-02").ok).toBe(false);
    expect(validerPeriode(20260901, "2026-09-02").ok).toBe(false);
  });

  it("borne une période démesurée plutôt que de balayer la table", () => {
    expect(validerPeriode("2020-01-01", "2026-09-01").ok).toBe(false);
    // Juste en dessous de la borne : accepté, sinon le refus mordrait sur des
    // demandes légitimes (un an de recul se demande couramment).
    expect(validerPeriode("2026-01-01", "2026-12-31").ok).toBe(true);
  });

  it("accepte une date calendairement fausse mais bien formée, et c'est assumé", () => {
    // `2026-02-31` passe le motif. Postgres la refusera à la requête, avec un
    // message clair. Dupliquer ici un calendrier complet ferait deux règles à
    // maintenir dont une seule serait vraiment appliquée — le contraire de ce
    // que fait le reste de ce module.
    expect(validerPeriode("2026-02-31", "2026-03-01").ok).toBe(true);
  });
});
