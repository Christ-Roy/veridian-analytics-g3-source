import { describe, expect, it } from "vitest";
import { getChannel } from "./getChannel.js";

describe("getChannel - UTM parameter fallback", () => {
  it("classifies traffic with custom UTM parameters as Referral when no HTTP referrer is present", () => {
    expect(getChannel("", "utm_source=my_app&utm_medium=custom")).toBe("Referral");
    expect(getChannel("", "utm_source=gsuite_extension")).toBe("Referral");
    expect(getChannel("", "utm_medium=custom_link")).toBe("Referral");
    expect(getChannel("", "utm_campaign=custom_campaign")).toBe("Referral");
  });

  it("retains Direct classification when no referrer and no UTM parameters exist", () => {
    expect(getChannel("", "")).toBe("Direct");
  });

  it("retains Referral classification for external referring domains", () => {
    expect(getChannel("https://external-site.com/blog", "")).toBe("Referral");
    expect(
      getChannel("https://example.com/page", "utm_source=custom_source", "example.com"),
    ).not.toBe("Referral");    
  });
});

describe("getChannel - identifiants de clic Google Ads (gclid, gbraid, wbraid)", () => {
  // gbraid (campagnes app-vers-web sur iOS) et wbraid (web sur iOS) remplacent le gclid
  // quand Google ne peut pas le poser. Un clic payant arrive alors sans UTM ni referrer :
  // sans ce traitement, il est compté en Direct.
  it("classe un clic gbraid seul en trafic payant, jamais en Direct", () => {
    expect(getChannel("", "gbraid=Cj0KCQiA_ABC123")).toBe("Paid Unknown");
  });

  it("classe un clic wbraid seul en trafic payant, jamais en Direct", () => {
    expect(getChannel("", "wbraid=Cj0KCQiA_XYZ789")).toBe("Paid Unknown");
  });

  it("traite gclid exactement comme gbraid et wbraid", () => {
    expect(getChannel("", "gclid=Cj0KCQiA_ABC123")).toBe(getChannel("", "gbraid=Cj0KCQiA_ABC123"));
    expect(getChannel("", "gclid=Cj0KCQiA_ABC123")).toBe(getChannel("", "wbraid=Cj0KCQiA_ABC123"));
  });

  it("classe en Paid Search un clic gbraid ou wbraid venu de google.com", () => {
    expect(getChannel("https://www.google.com/", "gbraid=Cj0KCQiA_ABC123")).toBe("Paid Search");
    expect(getChannel("https://www.google.com/", "wbraid=Cj0KCQiA_ABC123")).toBe("Paid Search");
  });

  it("ne change rien pour un clic gclid venu de google.com", () => {
    expect(getChannel("https://www.google.com/", "gclid=Cj0KCQiA_ABC123")).toBe("Paid Search");
  });

  it("laisse Direct le trafic sans aucun identifiant de clic", () => {
    expect(getChannel("", "")).toBe("Direct");
    expect(getChannel("", "un_param=valeur")).toBe("Direct");
  });

  it("laisse Organic Search une visite google.com sans identifiant de clic", () => {
    expect(getChannel("https://www.google.com/", "")).toBe("Organic Search");
  });
});
