import { describe, expect, it } from "vitest";
import { MICROSOFT_CONSUMER_TENANT_ID, isMicrosoftEmailProven } from "./microsoftIdentity.js";

// Ce booléen décide si un jeton Entra peut être rattaché à un compte existant,
// donc s'il peut en prendre le contrôle. Chaque cas ci-dessous est une porte
// qu'on ouvre ou qu'on ferme.

describe("isMicrosoftEmailProven", () => {
  it("accepte un tenant qui a fait vérifier son domaine (xms_edov)", () => {
    expect(isMicrosoftEmailProven({ xms_edov: true, tid: "00000000-0000-0000-0000-000000000000" })).toBe(true);
  });

  it("accepte xms_edov sérialisé en chaîne, Microsoft le fait", () => {
    // Sans ce cas, tout le monde retomberait silencieusement sur « non prouvé »
    // et le login échouerait sans rien dire d'utile.
    expect(isMicrosoftEmailProven({ xms_edov: "true", tid: "un-tenant" })).toBe(true);
  });

  it("accepte un compte Microsoft personnel, reconnu à son tenant constant", () => {
    expect(isMicrosoftEmailProven({ tid: MICROSOFT_CONSUMER_TENANT_ID })).toBe(true);
  });

  it("REFUSE un tenant quelconque sans xms_edov — c'est la parade à nOAuth", () => {
    // Le scénario d'attaque : quelqu'un crée son propre annuaire Entra, y
    // déclare un utilisateur portant l'adresse de sa victime, et se connecte.
    expect(isMicrosoftEmailProven({ email: "victime@veridian.site", tid: "annuaire-de-l-attaquant" })).toBe(false);
  });

  it("REFUSE un xms_edov absent, faux, ou faussement vrai", () => {
    expect(isMicrosoftEmailProven({ tid: "un-tenant" })).toBe(false);
    expect(isMicrosoftEmailProven({ xms_edov: false, tid: "un-tenant" })).toBe(false);
    expect(isMicrosoftEmailProven({ xms_edov: "false", tid: "un-tenant" })).toBe(false);
    expect(isMicrosoftEmailProven({ xms_edov: 1, tid: "un-tenant" })).toBe(false);
  });

  it("REFUSE un jeton sans aucun des deux claims", () => {
    expect(isMicrosoftEmailProven({})).toBe(false);
  });
});
