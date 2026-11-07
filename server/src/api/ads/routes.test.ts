import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ce que ce fichier protège : la garde d'autorisation des routes Ads, et le
 * fait qu'aucune réponse ne laisse fuir le compte d'un autre site.
 *
 * Pourquoi une vraie base plutôt qu'un `getUserHasAdminAccessToSite` bouchonné :
 * un bouchon prouverait qu'on a appelé une fonction, pas qu'elle refuse. Ici
 * l'appartenance à l'organisation est lue en SQL par le VRAI code d'accès, donc
 * le test rougit si la garde disparaît — vérifié en la retirant (voir le
 * rapport de lot).
 *
 * Aucun test ne monte Fastify dans ce dépôt : on appelle le handler exporté,
 * avec les mêmes stubs `requestStub` / `replyStub` que
 * `api/stripe/createPortalSession.test.ts`.
 */

// Better-auth tire l'e-mail, Stripe et la configuration d'environnement à
// l'import : on neutralise l'API de session, l'identité vient de `req.user`.
vi.mock("../../lib/auth.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => null),
      verifyApiKey: vi.fn(async () => ({ valid: false })),
      getMcpSession: vi.fn(async () => null),
    },
  },
}));

// Le résolveur de jeton porteur facture chaque vérification au limiteur, qui
// irait chercher Redis. Il a ses propres tests.
vi.mock("../../lib/apiRateLimitPolicy.js", () => ({
  consumeRateLimitForIdentity: vi.fn(async () => ({
    allowed: true,
    wouldHaveDenied: false,
    scope: null,
    burstLimit: 50,
    burstRemaining: 49,
    burstResetSeconds: 1,
    dailyLimit: 5_000,
    dailyRemaining: 4_999,
    dailyResetSeconds: 3_600,
    retryAfterSeconds: 0,
  })),
}));

vi.mock("../../db/postgres/postgres.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../../db/postgres/schema.js");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  return { db, sql: client };
});

import { db, sql } from "../../db/postgres/postgres.js";
import { adsConversionMappings, adsSiteSettings } from "../../db/postgres/schema.js";
import { invalidateSitesAccessCache } from "../../lib/auth-utils.js";
import {
  createAdsMapping,
  deleteAdsMapping,
  getAdsHealth,
  getAdsSettings,
  listAdsMappings,
  updateAdsSettings,
} from "./routes.js";

// Les tables lues par le code d'accès (colonnes nommées exactement comme le
// schéma drizzle) plus les trois tables du module.
const DDL = `
CREATE TABLE "member" (
  "id" text PRIMARY KEY, "organizationId" text NOT NULL, "userId" text NOT NULL,
  "role" text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now(),
  "has_restricted_site_access" boolean NOT NULL DEFAULT false
);
CREATE TABLE "member_site_access" (
  "id" serial PRIMARY KEY, "member_id" text NOT NULL, "site_id" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(), "created_by" text
);
CREATE TABLE "team" (
  "id" text PRIMARY KEY, "name" text NOT NULL, "organizationId" text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp,
  "memberCount" integer NOT NULL DEFAULT 0
);
CREATE TABLE "teamMember" (
  "id" text PRIMARY KEY, "teamId" text NOT NULL, "userId" text NOT NULL, "createdAt" timestamp,
  "membershipKey" text UNIQUE
);
CREATE TABLE "team_site_access" (
  "id" serial PRIMARY KEY, "team_id" text NOT NULL, "site_id" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);
-- Colonnes complètes : le code d'accès fait un select() sans projection, donc
-- une colonne manquante fait échouer la requête... et getSitesUserHasAccessTo
-- rattrape l'erreur en rendant []. Le refus serait alors un faux vert.
CREATE TABLE "sites" (
  "id" text, "site_id" serial PRIMARY KEY, "name" text NOT NULL, "type" text,
  "domain" text NOT NULL, "created_at" timestamp DEFAULT now(), "updated_at" timestamp DEFAULT now(),
  "created_by" text, "organization_id" text, "public" boolean DEFAULT false,
  "embed_enabled" boolean DEFAULT false, "saltUserIds" boolean DEFAULT false,
  "blockBots" boolean DEFAULT true NOT NULL, "first_party_proxy" boolean DEFAULT false,
  "excluded_ips" jsonb DEFAULT '[]', "excluded_countries" jsonb DEFAULT '[]',
  "excluded_paths" jsonb DEFAULT '[]', "excluded_hostnames" jsonb DEFAULT '[]',
  "excluded_user_agents" jsonb DEFAULT '[]', "excluded_asns" jsonb DEFAULT '[]',
  "excluded_query_params" jsonb DEFAULT '[]', "sessionReplay" boolean DEFAULT false,
  "webVitals" boolean DEFAULT false, "trackErrors" boolean DEFAULT false,
  "trackOutbound" boolean DEFAULT true, "trackUrlParams" boolean DEFAULT true,
  "trackInitialPageView" boolean DEFAULT true, "trackSpaNavigation" boolean DEFAULT true,
  "trackIp" boolean DEFAULT false, "trackButtonClicks" boolean DEFAULT false,
  "trackCopy" boolean DEFAULT false, "trackFormInteractions" boolean DEFAULT false,
  "trackFormFields" boolean DEFAULT false, "api_key" text, "private_link_key" text,
  "tags" jsonb DEFAULT '[]'
);

CREATE TABLE "ads_site_settings" (
  "site_id" integer PRIMARY KEY NOT NULL REFERENCES "sites"("site_id") ON DELETE cascade,
  "customer_id" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "test_mode" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ads_site_settings_customer_id_check" CHECK ("customer_id" ~ '^[0-9]+$')
);
-- Lot G : bilan du dernier passage du balayage. Cette table est lue par
-- etatSante, donc tout jeu de tests qui appelle etatSante doit la porter.
CREATE TABLE "ads_scan_state" (
  "site_id" integer PRIMARY KEY NOT NULL REFERENCES "sites"("site_id") ON DELETE cascade,
  "last_run_at" timestamp NOT NULL,
  "events_examined" integer DEFAULT 0 NOT NULL,
  "recorded" integer DEFAULT 0 NOT NULL,
  "already_known" integer DEFAULT 0 NOT NULL,
  "duplicates" integer DEFAULT 0 NOT NULL,
  "skipped_no_consent" integer DEFAULT 0 NOT NULL,
  "skipped_no_click" integer DEFAULT 0 NOT NULL,
  "errors" integer DEFAULT 0 NOT NULL,
  "truncated" boolean DEFAULT false NOT NULL,
  "unmapped_events" integer DEFAULT 0 NOT NULL,
  "unmapped_top_names" text,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "ads_conversion_mappings" (
  "id" serial PRIMARY KEY,
  "site_id" integer NOT NULL REFERENCES "sites"("site_id") ON DELETE cascade,
  "event_name" text NOT NULL, "conversion_action_id" text NOT NULL,
  "default_value" numeric(14, 2), "currency" text DEFAULT 'EUR' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ads_conversion_mappings_site_event_unique" UNIQUE("site_id","event_name"),
  CONSTRAINT "ads_conversion_mappings_action_id_check" CHECK ("conversion_action_id" ~ '^[0-9]+$')
);
CREATE TABLE "ads_conversion_outbox" (
  "id" serial PRIMARY KEY,
  "site_id" integer NOT NULL REFERENCES "sites"("site_id") ON DELETE cascade,
  "business_event_id" text NOT NULL, "conversion_action_id" text NOT NULL,
  "click_id_type" text NOT NULL, "click_id" text NOT NULL, "occurred_at" timestamp NOT NULL,
  "value" numeric(14, 2), "currency" text DEFAULT 'EUR' NOT NULL,
  "consent_ad_user_data" text NOT NULL, "consent_ad_personalization" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL, "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp DEFAULT now() NOT NULL, "last_error" text, "sent_at" timestamp,
  "google_request_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL
);
`;

const NOW = "2026-01-01 00:00:00";
const SITE_A = 1;
const SITE_B = 2;
const COMPTE_A = "2568911678";
const COMPTE_B = "6437191896";

function replyStub() {
  const reply: any = { statusCode: 200 };
  reply.status = (code: number) => {
    reply.statusCode = code;
    return reply;
  };
  reply.send = (body: unknown) => {
    reply.body = body;
    return reply;
  };
  return reply;
}

function requestStub(userId: string | undefined, params: Record<string, string>, body?: unknown) {
  return {
    user: userId ? { id: userId } : undefined,
    headers: {},
    params,
    body,
    log: { error: () => {} },
  } as any;
}

// 🔴 Le démarrage de la base est HORS du `beforeAll`, et il doit y rester.
//
// PGlite est un Postgres compilé en WebAssembly : `new PGlite()` ne coûte rien
// (1 ms mesuré le 31/08/2026), c'est la PREMIÈRE requête qui paie le démarrage
// du moteur — 4 851 ms sur ce runner au repos, bien davantage quand la machine
// est disputée. Tant que ce DDL vivait dans un `beforeAll`, ce coût fixe
// d'infrastructure était facturé au budget du hook : le fichier rougissait
// AVANT qu'un seul test soit évalué, et le verdict dépendait de la charge de la
// machine plutôt que du code. Les rouges changeaient d'une exécution à l'autre.
//
// Au niveau module, ce démarrage est payé pendant la COLLECTE, qui n'a pas de
// budget de temps. Les hooks ne portent plus que ce qu'ils mesurent vraiment
// (le TRUNCATE entre deux tests, quelques millisecondes), et aucun délai n'a
// été relevé pour y arriver.
//
// Base NON partagée entre fichiers, délibérément : deux fichiers qui
// partageraient une instance partageraient son état, et un test vert seul
// deviendrait rouge en suite. Le coût d'un démarrage par fichier est le prix de
// l'isolation.
await (sql as any).exec(DDL);

beforeEach(async () => {
  await (sql as any).exec(
    `TRUNCATE "ads_conversion_outbox", "ads_conversion_mappings", "ads_scan_state", "ads_site_settings",
              "member", "member_site_access", "team", "teamMember", "team_site_access", "sites"`
  );
  await (sql as any).exec(`
    INSERT INTO "sites" ("id","site_id","name","domain","organization_id","public") VALUES
      ('hex_a', ${SITE_A}, 'site-a', 'a.example.com', 'org_a', true),
      ('hex_b', ${SITE_B}, 'site-b', 'b.example.com', 'org_b', false);
    INSERT INTO "member" ("id","organizationId","userId","role","createdAt") VALUES
      ('m_a_admin','org_a','u_a_admin','owner','${NOW}'),
      ('m_a_membre','org_a','u_a_membre','member','${NOW}'),
      ('m_b_admin','org_b','u_b_admin','owner','${NOW}');
  `);
  for (const u of ["u_a_admin", "u_a_membre", "u_b_admin", "u_inconnu"]) invalidateSitesAccessCache(u);

  await db.insert(adsSiteSettings).values([
    { siteId: SITE_A, customerId: COMPTE_A },
    { siteId: SITE_B, customerId: COMPTE_B, enabled: true },
  ]);
  await db.insert(adsConversionMappings).values([
    { siteId: SITE_A, eventName: "order_paid", conversionActionId: "111111111" },
    { siteId: SITE_B, eventName: "order_paid", conversionActionId: "222222222" },
  ]);
});

describe("routes Ads — le parcours nominal", () => {
  it("rend les réglages du site à son administrateur", async () => {
    const reply = replyStub();
    await getAdsSettings(requestStub("u_a_admin", { siteId: String(SITE_A) }), reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body.configured).toBe(true);
    expect(reply.body.settings).toMatchObject({ siteId: SITE_A, customerId: COMPTE_A, enabled: false });
  });

  it("enregistre un compte, une activation, des correspondances, et rend l'état de santé", async () => {
    const maj = replyStub();
    await updateAdsSettings(
      requestStub("u_a_admin", { siteId: String(SITE_A) }, { enabled: true, testMode: true }),
      maj
    );
    expect(maj.statusCode).toBe(200);
    expect(maj.body.settings).toMatchObject({ enabled: true, testMode: true, customerId: COMPTE_A });

    const creation = replyStub();
    await createAdsMapping(
      requestStub("u_a_admin", { siteId: String(SITE_A) }, { eventName: "signup", conversionActionId: "333333333" }),
      creation
    );
    expect(creation.statusCode).toBe(201);

    const liste = replyStub();
    await listAdsMappings(requestStub("u_a_admin", { siteId: String(SITE_A) }), liste);
    expect(liste.body.mappings.map((m: any) => m.eventName)).toEqual(["order_paid", "signup"]);

    const sante = replyStub();
    await getAdsHealth(requestStub("u_a_admin", { siteId: String(SITE_A) }), sante);
    expect(sante.body).toMatchObject({ configured: true, enabled: true, testMode: true, mappings: 2, pending: 0 });

    const suppression = replyStub();
    await deleteAdsMapping(
      requestStub("u_a_admin", { siteId: String(SITE_A), mappingId: String(creation.body.mapping.id) }),
      suppression
    );
    expect(suppression.statusCode).toBe(200);
  });

  it("refuse une saisie invalide avec un message exploitable, pas un 500", async () => {
    const tirets = replyStub();
    await updateAdsSettings(requestStub("u_a_admin", { siteId: String(SITE_A) }, { customerId: "256-891-1678" }), tirets);
    expect(tirets.statusCode).toBe(400);
    expect(tirets.body.error).toContain("2568911678");

    const etiquette = replyStub();
    await createAdsMapping(
      requestStub("u_a_admin", { siteId: String(SITE_A) }, {
        eventName: "achat",
        conversionActionId: "AW-18413758700/cL48CMKl_OkcEOzRrsxE",
      }),
      etiquette
    );
    expect(etiquette.statusCode).toBe(400);
    expect(etiquette.body.error).toMatch(/étiquette du tag/);

    const doublon = replyStub();
    await createAdsMapping(
      requestStub("u_a_admin", { siteId: String(SITE_A) }, { eventName: "order_paid", conversionActionId: "444444444" }),
      doublon
    );
    expect(doublon.statusCode).toBe(409);

    // Rien n'a bougé en base malgré trois refus.
    const restant = await db.select().from(adsConversionMappings);
    expect(restant.filter(m => m.siteId === SITE_A)).toHaveLength(1);
    expect((await db.select().from(adsSiteSettings)).find(r => r.siteId === SITE_A)!.customerId).toBe(COMPTE_A);
  });

  it("encaisse une requête SANS CORPS au lieu de tomber dessus", async () => {
    // Fastify livre `body: undefined` sur un PUT ou un POST sans charge utile,
    // et rien dans la chaîne de `preHandler` ne l'en empêche. Sans le repli sur
    // un objet vide, la validation lit une propriété de `undefined` : l'appelant
    // reçoit un 500 illisible là où sa requête était simplement incomplète, et
    // le journal se remplit de TypeError qui ressemblent à une panne du module.
    //
    // La conduite attendue diffère selon le geste, et c'est voulu :
    //  - un enregistrement de réglages sans corps ne change RIEN et le dit en
    //    200. C'est le comportement correct d'une mise à jour partielle : les
    //    champs absents gardent leur valeur, donc un corps vide est un no-op.
    //    Le refuser obligerait chaque appelant à renvoyer l'état complet ;
    //  - une création de correspondance sans corps est un 400 : il n'y a pas de
    //    valeur précédente à conserver, donc rien à créer.
    const avant = (await db.select().from(adsSiteSettings)).find(r => r.siteId === SITE_A)!;

    const reglages = replyStub();
    await updateAdsSettings(requestStub("u_a_admin", { siteId: String(SITE_A) }, undefined), reglages);
    expect(reglages.statusCode).toBe(200);
    expect(reglages.body.settings).toMatchObject({
      customerId: avant.customerId,
      enabled: avant.enabled,
      testMode: avant.testMode,
    });

    const mapping = replyStub();
    await createAdsMapping(requestStub("u_a_admin", { siteId: String(SITE_A) }, undefined), mapping);
    expect(mapping.statusCode).toBe(400);

    // Rien n'a bougé en base dans un cas comme dans l'autre.
    expect((await db.select().from(adsSiteSettings)).find(r => r.siteId === SITE_A)).toMatchObject({
      customerId: avant.customerId,
      enabled: avant.enabled,
    });
    expect((await db.select().from(adsConversionMappings)).filter(m => m.siteId === SITE_A)).toHaveLength(1);
  });

  it("refuse un identifiant de site qui n'en est pas un", async () => {
    const reply = replyStub();
    await getAdsSettings(requestStub("u_a_admin", { siteId: "pas-un-nombre" }), reply);
    expect(reply.statusCode).toBe(400);
  });
});

describe("routes Ads — la garde d'autorisation", () => {
  it("refuse l'accès CROISÉ : l'administrateur du site A ne lit pas le site B", async () => {
    const reply = replyStub();
    await getAdsSettings(requestStub("u_a_admin", { siteId: String(SITE_B) }), reply);

    expect(reply.statusCode).toBe(403);
    // Et surtout : le compte Ads du site B n'apparaît nulle part dans la réponse.
    expect(JSON.stringify(reply.body)).not.toContain(COMPTE_B);
  });

  it("refuse l'écriture croisée et laisse les réglages du site B intacts", async () => {
    const reply = replyStub();
    await updateAdsSettings(
      requestStub("u_a_admin", { siteId: String(SITE_B) }, { customerId: COMPTE_A, enabled: false }),
      reply
    );

    expect(reply.statusCode).toBe(403);
    // Détourner les conversions d'un client vers un autre compte Ads serait
    // invisible dans l'interface : on vérifie la base, pas seulement le code.
    const [b] = (await db.select().from(adsSiteSettings)).filter(r => r.siteId === SITE_B);
    expect(b).toMatchObject({ customerId: COMPTE_B, enabled: true });
  });

  it("refuse la lecture croisée des correspondances et de l'état de santé", async () => {
    for (const handler of [listAdsMappings, getAdsHealth]) {
      const reply = replyStub();
      await handler(requestStub("u_a_admin", { siteId: String(SITE_B) }), reply);
      expect(reply.statusCode).toBe(403);
      expect(JSON.stringify(reply.body)).not.toContain("222222222");
    }
  });

  it("ne supprime pas la correspondance d'un autre site, même en devinant son identifiant", async () => {
    const [chezB] = (await db.select().from(adsConversionMappings)).filter(m => m.siteId === SITE_B);

    // Cas 1 : la garde parle — le site demandé est celui de B.
    const croise = replyStub();
    await deleteAdsMapping(requestStub("u_a_admin", { siteId: String(SITE_B), mappingId: String(chezB.id) }), croise);
    expect(croise.statusCode).toBe(403);

    // Cas 2 : la garde passe (site A, autorisé) mais l'identifiant vise B. La
    // requête est bornée au site, donc c'est un 404 et rien n'est supprimé.
    const devine = replyStub();
    await deleteAdsMapping(requestStub("u_a_admin", { siteId: String(SITE_A), mappingId: String(chezB.id) }), devine);
    expect(devine.statusCode).toBe(404);

    expect((await db.select().from(adsConversionMappings)).filter(m => m.siteId === SITE_B)).toHaveLength(1);
  });

  it("laisse lire un membre non administrateur mais lui refuse toute écriture", async () => {
    const lecture = replyStub();
    await getAdsSettings(requestStub("u_a_membre", { siteId: String(SITE_A) }), lecture);
    expect(lecture.statusCode).toBe(200);

    for (const [handler, params, body] of [
      [updateAdsSettings, { siteId: String(SITE_A) }, { enabled: true }],
      [createAdsMapping, { siteId: String(SITE_A) }, { eventName: "x", conversionActionId: "9" }],
      [deleteAdsMapping, { siteId: String(SITE_A), mappingId: "1" }, undefined],
    ] as const) {
      const reply = replyStub();
      await (handler as any)(requestStub("u_a_membre", params as any, body), reply);
      expect(reply.statusCode).toBe(403);
    }
  });

  it("refuse un utilisateur anonyme, y compris sur un site marqué public", async () => {
    // Le site A est public : `publicSiteScoped` laisserait passer un visiteur.
    // Ces routes nomment le compte Ads du client, donc elles n'en relèvent pas.
    const reply = replyStub();
    await getAdsSettings(requestStub(undefined, { siteId: String(SITE_A) }), reply);
    expect(reply.statusCode).toBe(403);
    expect(JSON.stringify(reply.body)).not.toContain(COMPTE_A);
  });
});

describe("routes Ads — aucun secret ne sort", () => {
  it("ne rend que des champs de réglage, jamais de jeton", async () => {
    const reply = replyStub();
    await getAdsSettings(requestStub("u_a_admin", { siteId: String(SITE_A) }), reply);

    expect(Object.keys(reply.body.settings).sort()).toEqual([
      "createdAt",
      "customerId",
      "enabled",
      "siteId",
      "testMode",
      "updatedAt",
    ]);
  });

  it("ne lit aucun identifiant OAuth dans le code du lot", () => {
    // Contrôle sur le TEXTE SOURCE : les identifiants du compte administrateur
    // vivent dans la configuration serveur (décision n°1 du 2026-08-29) et ce
    // module n'a aucune raison d'y toucher. Une régression ici — un « et si on
    // renvoyait aussi le refresh_token pour déboguer » — ne se verrait pas
    // autrement, puisque la réponse resterait un 200 parfaitement valide.
    const interdits = /GOOGLE_ADS_|refresh_token|refreshToken|client_secret|clientSecret|access_token/;
    for (const fichier of ["settings.ts", "routes.ts"]) {
      const source = readFileSync(join(import.meta.dirname, fichier), "utf8");
      expect(source, `${fichier} ne doit toucher à aucun secret`).not.toMatch(interdits);
    }
  });
});
