import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";

import {
  adsConversionMappings,
  adsConversionOutbox,
  adsSiteSettings,
} from "../../db/postgres/schema.js";

/**
 * Ce que ce fichier protège : la clé d'idempotence du journal de conversions.
 *
 * C'est la seule chose du lot qui, en cassant, ne ferait AUCUN bruit. Une
 * conversion envoyée deux fois à Google reçoit deux HTTP 200 ; le tableau de
 * bord Ads affiche simplement un chiffre trop haut, et les enchères se règlent
 * dessus. Il n'y a ni erreur, ni log, ni alerte à attendre. D'où un test qui
 * INSÈRE réellement dans un Postgres (PGlite) plutôt qu'un test qui relirait la
 * déclaration drizzle : ce qui compte est que la base refuse, pas que le
 * TypeScript le prétende.
 *
 * Le DDL est celui de la migration 0016, recopié : le rejouer ici vérifie
 * accessoirement qu'il s'applique sur une base vierge.
 */

const client = new PGlite();
const db = drizzle(client);

const DDL = `
CREATE TABLE "sites" ("site_id" serial PRIMARY KEY, "name" text NOT NULL);

CREATE TABLE "ads_site_settings" (
  "site_id" integer PRIMARY KEY NOT NULL REFERENCES "sites"("site_id") ON DELETE cascade,
  "customer_id" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "test_mode" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ads_site_settings_customer_id_check" CHECK ("customer_id" ~ '^[0-9]+$')
);

CREATE TABLE "ads_conversion_mappings" (
  "id" serial PRIMARY KEY,
  "site_id" integer NOT NULL REFERENCES "sites"("site_id") ON DELETE cascade,
  "event_name" text NOT NULL,
  "conversion_action_id" text NOT NULL,
  "default_value" numeric(14, 2),
  "currency" text DEFAULT 'EUR' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ads_conversion_mappings_site_event_unique" UNIQUE("site_id","event_name"),
  CONSTRAINT "ads_conversion_mappings_action_id_check" CHECK ("conversion_action_id" ~ '^[0-9]+$')
);

CREATE TABLE "ads_conversion_outbox" (
  "id" serial PRIMARY KEY,
  "site_id" integer NOT NULL REFERENCES "sites"("site_id") ON DELETE cascade,
  "business_event_id" text NOT NULL,
  "conversion_action_id" text NOT NULL,
  "click_id_type" text NOT NULL,
  "click_id" text NOT NULL,
  "click_at" timestamp NOT NULL,
  "occurred_at" timestamp NOT NULL,
  "value" numeric(14, 2),
  "currency" text DEFAULT 'EUR' NOT NULL,
  "consent_ad_user_data" text NOT NULL,
  "consent_ad_personalization" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp DEFAULT now() NOT NULL,
  "last_error" text,
  "sent_at" timestamp,
  "google_request_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ads_conversion_outbox_idempotence_unique" UNIQUE("site_id","business_event_id","conversion_action_id"),
  CONSTRAINT "ads_conversion_outbox_status_check" CHECK ("status" IN ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT "ads_conversion_outbox_click_id_type_check" CHECK ("click_id_type" IN ('gclid', 'gbraid', 'wbraid'))
);

CREATE INDEX "ads_conversion_outbox_drain_idx" ON "ads_conversion_outbox" USING btree ("next_attempt_at") WHERE status = 'pending';
CREATE INDEX "ads_conversion_outbox_site_status_idx" ON "ads_conversion_outbox" USING btree ("site_id","status");
CREATE INDEX "ads_conversion_mappings_site_idx" ON "ads_conversion_mappings" USING btree ("site_id");
`;

/**
 * Drizzle enrobe l'erreur Postgres dans un « Failed query: … » qui ne porte PAS
 * le nom de la contrainte : celui-ci vit dans `cause`. Assertion faite sur le
 * message brut, un test « la contrainte mord » passerait donc au vert pour
 * n'importe quelle autre erreur d'insertion — un NOT NULL oublié, une colonne
 * renommée. On déplie donc la chaîne des causes et on exige le nom exact.
 */
async function echoueSur(promesse: Promise<unknown>, contrainte: RegExp) {
  let capturee: unknown;
  try {
    await promesse;
  } catch (e) {
    capturee = e;
  }
  expect(capturee, "l'insertion aurait dû être refusée").toBeDefined();

  const messages: string[] = [];
  for (let e: any = capturee; e; e = e.cause) messages.push(String(e.message ?? e));
  expect(messages.join(" | ")).toMatch(contrainte);
}

const conversion = {
  siteId: 1,
  businessEventId: "order_4711",
  conversionActionId: "987654321",
  clickIdType: "gclid",
  clickId: "Cj0KCQjw_TEST",
  clickAt: "2026-08-29 09:00:00",
  occurredAt: "2026-08-29 10:00:00",
  value: "42.90",
  consentAdUserData: "CONSENT_GRANTED",
  consentAdPersonalization: "CONSENT_GRANTED",
};

// 60 s : le premier appel démarre le moteur Postgres en WebAssembly, ce qui
// dépasse largement le délai par défaut de 10 s sur une machine chargée.
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
await client.exec(DDL);

beforeEach(async () => {
  await client.exec(`TRUNCATE "ads_conversion_outbox", "ads_conversion_mappings", "ads_site_settings", "sites" RESTART IDENTITY CASCADE`);
  await client.exec(`INSERT INTO "sites" ("site_id","name") VALUES (1,'asd'), (2,'autre')`);
});

describe("ads_conversion_outbox — la clé d'idempotence", () => {
  it("refuse une seconde ligne pour le même (site, événement métier, action)", async () => {
    await db.insert(adsConversionOutbox).values(conversion);

    // Le rejeu : mêmes trois colonnes, tout le reste différent. C'est le cas
    // réel — un drain relancé, un webhook redélivré — et il doit échouer.
    await echoueSur(
      db.insert(adsConversionOutbox).values({
        ...conversion,
        clickId: "Cj0KCQjw_AUTRE",
        value: "99.00",
        clickAt: "2026-08-30 08:00:00",
        occurredAt: "2026-08-30 11:00:00",
      }),
      /ads_conversion_outbox_idempotence_unique/
    );

    const lignes = await db.select().from(adsConversionOutbox);
    expect(lignes).toHaveLength(1);
    expect(lignes[0].clickId).toBe("Cj0KCQjw_TEST");
  });

  it("ne crée rien de plus avec onConflictDoNothing, la forme que prendra le drain", async () => {
    await db.insert(adsConversionOutbox).values(conversion);
    await db.insert(adsConversionOutbox).values(conversion).onConflictDoNothing();

    expect(await db.select().from(adsConversionOutbox)).toHaveLength(1);
  });

  // Contrôle négatif : sans ces trois colonnes ensemble, la contrainte ne dit
  // rien. Si l'un de ces trois cas se mettait à échouer, c'est que la clé
  // serait devenue trop large et bloquerait des conversions légitimes.
  it("laisse passer ce qui diffère par le site, l'événement ou l'action", async () => {
    await db.insert(adsConversionOutbox).values(conversion);
    await db.insert(adsConversionOutbox).values({ ...conversion, siteId: 2 });
    await db.insert(adsConversionOutbox).values({ ...conversion, businessEventId: "order_4712" });
    await db.insert(adsConversionOutbox).values({ ...conversion, conversionActionId: "123456789" });

    expect(await db.select().from(adsConversionOutbox)).toHaveLength(4);
  });

  it("emporte les conversions quand le site disparaît", async () => {
    await db.insert(adsConversionOutbox).values(conversion);
    await client.exec(`DELETE FROM "sites" WHERE "site_id" = 1`);

    expect(await db.select().from(adsConversionOutbox)).toHaveLength(0);
  });

  // L'instant du clic est la seule donnée qui permette au drain de voir qu'une
  // ligne a vieilli hors de la fenêtre de 90 jours pendant ses tentatives. Un
  // clic hors fenêtre reçoit un HTTP 200 et n'est jamais compté : sans cette
  // colonne, la panne serait strictement invisible.
  it("exige l'instant du clic, et le garde distinct de celui de la conversion", async () => {
    const { clickAt, ...sansClickAt } = conversion;

    await echoueSur(
      db.insert(adsConversionOutbox).values(sansClickAt as typeof conversion),
      /click_at/
    );

    await db.insert(adsConversionOutbox).values(conversion);
    const [ligne] = await db.select().from(adsConversionOutbox);
    expect(ligne.clickAt).toBe("2026-08-29 09:00:00");
    expect(ligne.occurredAt).toBe("2026-08-29 10:00:00");
    // Si ces deux valeurs se confondaient, le contrôle des 90 jours
    // sous-estimerait l'âge du clic et serait vert à tort.
    expect(ligne.clickAt).not.toBe(ligne.occurredAt);
  });

  // Les trois états terminaux, et surtout la séparation failed / skipped : un
  // envoi refusé par nos règles métier n'est pas une panne, et le compter comme
  // telle ferait chercher un incident qui n'existe pas.
  it("accepte les quatre états, et eux seuls", async () => {
    for (const status of ["pending", "sent", "failed", "skipped"]) {
      await db
        .insert(adsConversionOutbox)
        .values({ ...conversion, businessEventId: `order_${status}`, status });
    }
    expect(await db.select().from(adsConversionOutbox)).toHaveLength(4);

    await echoueSur(
      db.insert(adsConversionOutbox).values({
        ...conversion,
        businessEventId: "order_autre",
        status: "ignored",
      }),
      /status_check/
    );
  });

  // Le piège des colonnes `timestamp` SANS fuseau : `now()` y écrit l'heure
  // MURALE de la session. Ce test ne protège pas un comportement, il FIGE le
  // défaut connu, pour que personne ne « simplifie » un jour un INSERT explicite
  // en s'en remettant au défaut. La panne serait muette dans les deux sens :
  // une ligne datée dans le futur dort dans la file, un `occurred_at` décalé
  // part faux chez Google.
  it("DEFAULT now() suit le fuseau de la session : ne jamais s'en remettre à lui", async () => {
    const lu = async (id: string) =>
      (await client.query<{ t: string }>(
        `SELECT "next_attempt_at"::text AS t FROM "ads_conversion_outbox" WHERE "business_event_id" = $1`,
        [id]
      )).rows[0].t;

    await client.exec(`SET TimeZone = 'UTC'`);
    await db.insert(adsConversionOutbox).values({ ...conversion, businessEventId: "utc" });

    await client.exec(`SET TimeZone = 'Europe/Paris'`);
    await db.insert(adsConversionOutbox).values({ ...conversion, businessEventId: "paris" });

    // Deux insertions à quelques millisecondes d'intervalle, deux heures d'écart
    // enregistrées. Rien dans Postgres ne le signale.
    const ecartMs = Date.parse(await lu("paris")) - Date.parse(await lu("utc"));
    expect(ecartMs).toBeGreaterThan(60 * 60 * 1000);

    // Un horodatage posé explicitement, lui, ne bouge pas d'un fuseau à l'autre.
    await db.insert(adsConversionOutbox).values({
      ...conversion,
      businessEventId: "explicite",
      nextAttemptAt: "2026-08-29 10:00:00",
    });
    await client.exec(`SET TimeZone = 'UTC'`);
    expect(await lu("explicite")).toBe("2026-08-29 10:00:00");
  });

  it("refuse un état ou un type d'identifiant de clic inventé", async () => {
    await echoueSur(
      db.insert(adsConversionOutbox).values({ ...conversion, status: "en_cours" }),
      /status_check/
    );

    await echoueSur(
      db.insert(adsConversionOutbox).values({ ...conversion, clickIdType: "fbclid" }),
      /click_id_type_check/
    );
  });
});

describe("ads_conversion_mappings et ads_site_settings", () => {
  it("interdit deux actions de conversion pour le même événement d'un site", async () => {
    await db.insert(adsConversionMappings).values({
      siteId: 1,
      eventName: "order_paid",
      conversionActionId: "987654321",
    });

    // Sans cette unicité, un achat partirait deux fois vers deux actions et
    // serait compté deux fois, sans qu'aucune erreur ne le signale.
    await echoueSur(
      db.insert(adsConversionMappings).values({
        siteId: 1,
        eventName: "order_paid",
        conversionActionId: "123456789",
      }),
      /ads_conversion_mappings_site_event_unique/
    );
  });

  it("pose EUR par défaut et accepte une valeur par défaut absente", async () => {
    await db.insert(adsConversionMappings).values({
      siteId: 1,
      eventName: "signup",
      conversionActionId: "555",
    });

    const [m] = await db.select().from(adsConversionMappings).where(eq(adsConversionMappings.siteId, 1));
    expect(m.currency).toBe("EUR");
    expect(m.defaultValue).toBeNull();
  });

  it("naît désactivé et hors mode d'essai", async () => {
    await db.insert(adsSiteSettings).values({ siteId: 1, customerId: "2568911678" });

    const [reglages] = await db.select().from(adsSiteSettings);
    expect(reglages.enabled).toBe(false);
    expect(reglages.testMode).toBe(false);
  });

  it("refuse un identifiant de compte au format à tirets", async () => {
    // La faute la plus probable : le format affiché par l'interface Google Ads,
    // copié tel quel. Sans ce contrôle elle ne se verrait qu'au premier envoi.
    await echoueSur(
      db.insert(adsSiteSettings).values({ siteId: 1, customerId: "256-891-1678" }),
      /customer_id_check/
    );
  });

  it("n'accepte qu'un seul compte Ads par site", async () => {
    await db.insert(adsSiteSettings).values({ siteId: 1, customerId: "2568911678" });

    await echoueSur(
      db.insert(adsSiteSettings).values({ siteId: 1, customerId: "6437191896" }),
      /ads_site_settings_pkey/
    );
  });
});
