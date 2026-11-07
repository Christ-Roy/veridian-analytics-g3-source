import { readFileSync } from "fs";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { beforeEach, describe, expect, it } from "vitest";
import { magicLinkVerifyRateLimitRules } from "./magicLinkRateLimit.js";

const BASE = "https://analytics.exemple.fr";
const db: Record<string, any[]> = { user: [], session: [], account: [], verification: [], rateLimit: [] };

// Le vrai limiteur, avec la même règle du plugin que `auth.ts` (3 par minute).
const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: BASE,
  secret: "secret-de-test-0123456789-0123456789",
  database: memoryAdapter(db),
  rateLimit: { enabled: true, customRules: magicLinkVerifyRateLimitRules },
  plugins: [
    magicLink({
      storeToken: "hashed",
      disableSignUp: true,
      rateLimit: { window: 60, max: 3 },
      sendMagicLink: async () => {},
    }),
  ],
});

let ip = 0;
let currentIp = "";

const verify = (index: number) =>
  auth.handler(
    new Request(`${BASE}/api/auth/magic-link/verify?token=faux-${index}&callbackURL=%2F`, {
      headers: { "x-forwarded-for": currentIp },
    })
  );

const sendMail = () =>
  auth.handler(
    new Request(`${BASE}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "x-forwarded-for": currentIp, "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "client@exemple.fr" }),
    })
  );

async function statuses(count: number, call: (index: number) => Promise<Response>) {
  const result: number[] = [];
  for (let index = 0; index < count; index++) {
    result.push((await call(index)).status);
  }
  return result;
}

beforeEach(() => {
  ip += 1;
  currentIp = `203.0.113.${ip}`;
});

describe("limite de la vérification du lien", () => {
  it("ne coupe pas les collègues d'un même bureau : 120 vérifications par minute passent", async () => {
    const result = await statuses(120, verify);

    expect(result.filter(status => status === 429)).toHaveLength(0);
  });

  it("freine toujours les essais de jetons au-delà de 120 par minute", async () => {
    await statuses(120, verify);

    expect((await verify(121)).status).toBe(429);
  });

  it("ne desserre pas l'envoi de mails : le 4e par minute reste refusé", async () => {
    const result = await statuses(4, sendMail);

    expect(result.slice(0, 3)).not.toContain(429);
    expect(result[3]).toBe(429);
  });

  it("est bien branchée sur la configuration servie", () => {
    const source = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");

    expect(source).toContain("rateLimit: { customRules: magicLinkVerifyRateLimitRules }");
  });
});
