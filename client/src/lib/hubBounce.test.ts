import { describe, expect, it } from "vitest";
import { hubBaseUrl, hubBounceUrl, hubContinueUrl } from "./hubBounce";

describe("hubBaseUrl", () => {
  it.each([
    ["https://analytics.app.veridian.site", "https://app.veridian.site"],
    ["https://analytics-rybbit.staging.veridian.site", "https://hub.staging.veridian.site"],
    ["http://localhost:3001", null],
    ["https://analytics.exemple.fr", null],
    ["https://veridian.site.exemple.fr", null],
    [undefined, null],
    ["pas une url", null],
  ])("%s donne %s", (backend, hub) => {
    expect(hubBaseUrl(backend)).toBe(hub);
  });
});

describe("adresses de rebond", () => {
  it("encode la page demandée et ne marque auto que sur demande", () => {
    expect(hubBounceUrl("https://hub", "https://a/b?c=1&d=2", true)).toBe(
      "https://hub/api/auth/bounce/prepare?next=https%3A%2F%2Fa%2Fb%3Fc%3D1%26d%3D2&auto=1"
    );
    expect(hubBounceUrl("https://hub", "https://a/", false)).toBe(
      "https://hub/api/auth/bounce/prepare?next=https%3A%2F%2Fa%2F"
    );
  });

  it("le bouton Continuer n'est jamais automatique, et absent sans Hub", () => {
    expect(hubContinueUrl("https://a", "https://hub")).not.toContain("auto=1");
    expect(hubContinueUrl("https://a", null)).toBeNull();
  });
});
