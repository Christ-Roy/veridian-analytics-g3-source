import { describe, expect, it } from "vitest";
import { validerCompteAds } from "./validation";

/**
 * Ce que ces cas protègent : le serveur refuse le format à tirets, à dessein.
 * Si la validation du navigateur venait à « aider » en retirant les tirets
 * elle-même, la saisie partirait corrigée sans que personne ne l'ait relue —
 * or c'est le compte qui reçoit l'argent publicitaire.
 */
describe("validerCompteAds", () => {
  it("accepte un identifiant de dix chiffres", () => {
    expect(validerCompteAds("2568911678")).toEqual({ ok: true, valeur: "2568911678" });
  });

  it("ignore les espaces autour de la saisie", () => {
    expect(validerCompteAds("  2568911678  ")).toEqual({ ok: true, valeur: "2568911678" });
  });

  it("refuse le format à tirets de l'interface Google, et propose la valeur exacte à coller", () => {
    const resultat = validerCompteAds("256-891-1678");

    expect(resultat.ok).toBe(false);
    expect(resultat).toMatchObject({ motif: "tirets", sansTirets: "2568911678" });
  });

  it("ne corrige JAMAIS les tirets en silence", () => {
    // Le jour où quelqu'un remplacerait le refus par un `replace(/-/g, "")`,
    // ce cas passerait au vert du mauvais côté : d'où l'assertion explicite.
    expect(validerCompteAds("256-891-1678").ok).toBe(false);
  });

  it("refuse une saisie vide", () => {
    expect(validerCompteAds("")).toMatchObject({ ok: false, motif: "vide" });
    expect(validerCompteAds("   ")).toMatchObject({ ok: false, motif: "vide" });
    expect(validerCompteAds(undefined)).toMatchObject({ ok: false, motif: "vide" });
  });

  it("refuse tout ce qui n'est pas un nombre nu", () => {
    expect(validerCompteAds("AW-18413758700")).toMatchObject({ ok: false, motif: "non_numerique" });
    expect(validerCompteAds("256 891 1678")).toMatchObject({ ok: false, motif: "non_numerique" });
    expect(validerCompteAds("customers/2568911678")).toMatchObject({ ok: false, motif: "non_numerique" });
  });

  it("refuse une longueur invraisemblable, qui n'échouerait autrement qu'au premier envoi", () => {
    expect(validerCompteAds("1")).toMatchObject({ ok: false, motif: "longueur" });
    expect(validerCompteAds("1234567")).toMatchObject({ ok: false, motif: "longueur" });
    expect(validerCompteAds("1234567890123")).toMatchObject({ ok: false, motif: "longueur" });
  });
});
