import { describe, expect, it } from "vitest";
import { AUCUN_MONTANT, estSansMontant, formaterMontant } from "./montant";

describe("formaterMontant", () => {
  it("distingue une valeur absente d'un zéro explicite", () => {
    expect(formaterMontant(null, "EUR")).toBe(AUCUN_MONTANT);
    expect(formaterMontant("", "EUR")).toBe(AUCUN_MONTANT);
    expect(formaterMontant("0.00", "EUR")).not.toBe(AUCUN_MONTANT);
  });

  it("formate la chaîne numérique rendue par l'API", () => {
    // La locale du runner n'est pas garantie : on vérifie ce qui est stable,
    // les chiffres et le symbole, pas l'ordre ni l'espace insécable.
    const rendu = formaterMontant("49.90", "EUR");
    expect(rendu).toContain("49");
    expect(rendu).toContain("90");
    expect(rendu).toContain("€");
  });

  it("ne lève pas sur une devise invalide venue de la base", () => {
    // Sans le try/catch, Intl lève ici et l'écran entier tombe au rendu.
    expect(() => formaterMontant("12", "€UR")).not.toThrow();
    expect(formaterMontant("12", "€UR")).toContain("12");
  });

  it("retombe sur l'euro quand la devise est absente", () => {
    expect(formaterMontant("5", null)).toContain("€");
  });
});

describe("estSansMontant", () => {
  it("signale l'absence de valeur ET le zéro, qui partent tous deux sans montant", () => {
    expect(estSansMontant(null)).toBe(true);
    expect(estSansMontant("")).toBe(true);
    expect(estSansMontant("0")).toBe(true);
    expect(estSansMontant("0.00")).toBe(true);
    expect(estSansMontant("0.01")).toBe(false);
    expect(estSansMontant(49.9)).toBe(false);
  });
});
