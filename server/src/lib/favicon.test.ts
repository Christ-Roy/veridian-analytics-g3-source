import { describe, expect, it } from "vitest";
import { faviconUrl } from "./favicon.js";

/**
 * Ce que ces tests protègent, ce n'est pas un affichage : c'est la promesse
 * commerciale. Une icône demandée à un tiers lui livre la liste des domaines
 * que nos clients mesurent et de leurs référents. La règle tient en une
 * phrase : l'URL produite pointe TOUJOURS sur le domaine lui-même, ou sur
 * rien.
 */
describe("faviconUrl", () => {
  it("sert l'icône depuis le domaine lui-même", () => {
    expect(faviconUrl("exemple.fr")).toBe("https://exemple.fr/favicon.ico");
  });

  it("ne produit jamais d'URL vers un service d'icônes tiers", () => {
    for (const entree of ["exemple.fr", "https://www.google.com/recherche", "sous.domaine.exemple.fr"]) {
      const url = faviconUrl(entree);
      expect(url).toBeDefined();
      expect(url).not.toMatch(/duckduckgo|google\.com\/s2|clearbit|microlink/);
    }
  });

  it("réduit une URL complète à son hôte", () => {
    expect(faviconUrl("https://exemple.fr/page?utm=x#ancre")).toBe("https://exemple.fr/favicon.ico");
    expect(faviconUrl("http://exemple.fr:8443/")).toBe("https://exemple.fr/favicon.ico");
  });

  it("normalise la casse", () => {
    expect(faviconUrl("Exemple.FR")).toBe("https://exemple.fr/favicon.ico");
  });

  it("écarte ce qui n'est pas un hôte, plutôt que de fabriquer une requête absurde", () => {
    // « Direct » et consorts sont des LIBELLÉS de dimension, pas des domaines.
    for (const entree of ["Direct", "(aucun)", "", "   ", "localhost", null, undefined]) {
      expect(faviconUrl(entree)).toBeUndefined();
    }
  });
});
