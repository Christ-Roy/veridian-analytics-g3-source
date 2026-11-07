import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ce que ce fichier protège : la validation des deux saisies qui, fausses, ne se
 * verraient qu'au premier envoi refusé par Google — plusieurs heures et un
 * journal d'échecs plus tard — et l'état de santé, seul endroit d'où l'on peut
 * apprendre qu'un drain est arrêté.
 *
 * Les contrôles s'exécutent contre un VRAI Postgres (PGlite), comme
 * `schema.test.ts` : ce qui compte est que l'écriture aboutisse ou soit refusée,
 * pas que le TypeScript le prétende.
 */
vi.mock("../../db/postgres/postgres.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../../db/postgres/schema.js");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  return { db, sql: client };
});

import { sql } from "../../db/postgres/postgres.js";
import {
  creerCorrespondance,
  enregistrerReglages,
  classerBalayage,
  etatSante,
  lireReglages,
  listerCorrespondances,
  supprimerCorrespondance,
  validerActionConversion,
  validerCompteAds,
  validerDevise,
  validerNomEvenement,
  validerValeurParDefaut,
} from "./settings.js";

// Seules les tables que ce module touche. DDL repris de la migration 0016.
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
  CONSTRAINT "ads_conversion_outbox_idempotence_unique" UNIQUE("site_id","business_event_id","conversion_action_id")
);

-- Lot G : le bilan du dernier passage du balayage. L'absence de ligne dit « le
-- balayage n'a jamais tourné », qui est un état à part entière.
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
`;

// 60 s : le premier appel démarre Postgres en WebAssembly.
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
    `TRUNCATE "ads_conversion_outbox", "ads_conversion_mappings", "ads_scan_state", "ads_site_settings", "sites" RESTART IDENTITY CASCADE`
  );
  await (sql as any).exec(`INSERT INTO "sites" ("site_id","name") VALUES (1,'asd'), (2,'autre')`);
});

describe("validerCompteAds", () => {
  it("accepte un compte numérique et rogne les espaces d'un copier-coller", () => {
    expect(validerCompteAds(" 2568911678 ")).toEqual({ ok: true, valeur: "2568911678" });
  });

  it("refuse le format à tirets de l'interface Google, en donnant la valeur à saisir", () => {
    const refus = validerCompteAds("256-891-1678");
    expect(refus.ok).toBe(false);
    // Le message doit porter la correction, pas seulement le constat : c'est ce
    // qui évite l'aller-retour « invalide » → « invalide » → abandon.
    expect((refus as any).message).toContain("2568911678");
  });

  it("refuse un compte vide, alphabétique, ou d'une longueur invraisemblable", () => {
    expect(validerCompteAds("").ok).toBe(false);
    expect(validerCompteAds(undefined).ok).toBe(false);
    expect(validerCompteAds("mon-compte").ok).toBe(false);
    // Passerait le CHECK de la base (`^[0-9]+$`) et n'échouerait qu'en 403 au
    // premier envoi : c'est exactement ce que la validation doit rattraper.
    expect(validerCompteAds("7").ok).toBe(false);
    expect(validerCompteAds("12345678901234").ok).toBe(false);
  });
});

describe("validerActionConversion", () => {
  it("accepte un identifiant numérique", () => {
    expect(validerActionConversion("987654321")).toEqual({ ok: true, valeur: "987654321" });
  });

  it("normalise la forme longue rendue par l'API Ads", () => {
    expect(validerActionConversion("customers/2568911678/conversionActions/987654321")).toEqual({
      ok: true,
      valeur: "987654321",
    });
  });

  it("refuse une étiquette de tag AW-…/… en disant que c'en est une", () => {
    // Cas réel : le compte ASD expose ces étiquettes sur la même page que
    // l'identifiant. Sans message dédié, on cherche au mauvais endroit.
    const refus = validerActionConversion("AW-18413758700/cL48CMKl_OkcEOzRrsxE");
    expect(refus.ok).toBe(false);
    expect((refus as any).message).toMatch(/étiquette du tag/);
  });

  it("refuse le vide et l'alphabétique", () => {
    expect(validerActionConversion("").ok).toBe(false);
    expect(validerActionConversion("conversion_achat").ok).toBe(false);
  });
});

describe("validerDevise et validerValeurParDefaut", () => {
  it("pose EUR par défaut, met en majuscules, refuse une devise inventée", () => {
    expect(validerDevise(undefined)).toEqual({ ok: true, valeur: "EUR" });
    expect(validerDevise("usd")).toEqual({ ok: true, valeur: "USD" });
    expect(validerDevise("EUROS").ok).toBe(false);
  });

  it("rend un montant à deux décimales, jamais un flottant, et refuse le négatif", () => {
    expect(validerValeurParDefaut(42.9)).toEqual({ ok: true, valeur: "42.90" });
    expect(validerValeurParDefaut("19")).toEqual({ ok: true, valeur: "19.00" });
    expect(validerValeurParDefaut(undefined)).toEqual({ ok: true, valeur: null });
    expect(validerValeurParDefaut(-1).ok).toBe(false);
    expect(validerValeurParDefaut("gratuit").ok).toBe(false);
  });
});

describe("enregistrerReglages", () => {
  it("crée des réglages désactivés puis les modifie sans réinitialiser le reste", async () => {
    const cree = await enregistrerReglages(1, { customerId: "2568911678" });
    expect(cree).toMatchObject({ ok: true });
    expect((cree as any).reglages).toMatchObject({ customerId: "2568911678", enabled: false, testMode: false });

    await enregistrerReglages(1, { testMode: true });
    // Un appel qui ne porte que `enabled` ne doit pas effacer le mode d'essai —
    // ce serait rouvrir l'envoi réel sans que personne l'ait demandé.
    const apres = await enregistrerReglages(1, { enabled: true });
    expect((apres as any).reglages).toMatchObject({ customerId: "2568911678", enabled: true, testMode: true });
  });

  it("refuse la création sans compte, et le compte à tirets avant la base", async () => {
    expect(await enregistrerReglages(1, { enabled: true })).toMatchObject({ ok: false });
    expect(await enregistrerReglages(1, { customerId: "256-891-1678" })).toMatchObject({ ok: false });
    expect(await lireReglages(1)).toBeNull();
  });

  it("refuse un booléen qui n'en est pas un", async () => {
    // "false" en chaîne vaut `true` en JavaScript : accepté tel quel, il
    // activerait l'envoi en croyant le désactiver.
    await enregistrerReglages(1, { customerId: "2568911678" });
    expect(await enregistrerReglages(1, { enabled: "false" })).toMatchObject({ ok: false });
    expect((await lireReglages(1))!.enabled).toBe(false);
  });
});

describe("correspondances", () => {
  it("crée, liste et supprime", async () => {
    const cree = await creerCorrespondance(1, {
      eventName: "order_paid",
      conversionActionId: "987654321",
      defaultValue: 42.9,
    });
    expect(cree).toMatchObject({ ok: true });

    const liste = await listerCorrespondances(1);
    expect(liste).toHaveLength(1);
    expect(liste[0]).toMatchObject({ eventName: "order_paid", conversionActionId: "987654321", currency: "EUR" });

    expect(await supprimerCorrespondance(1, liste[0].id)).toBe(true);
    expect(await listerCorrespondances(1)).toHaveLength(0);
  });

  it("refuse un doublon d'événement au lieu de l'écraser", async () => {
    await creerCorrespondance(1, { eventName: "order_paid", conversionActionId: "987654321" });
    const doublon = await creerCorrespondance(1, { eventName: "order_paid", conversionActionId: "123456789" });

    expect(doublon).toMatchObject({ ok: false, conflit: true });
    // L'action d'origine est intacte : un écrasement silencieux ferait partir
    // les conversions vers une autre action sans trace.
    expect((await listerCorrespondances(1))[0].conversionActionId).toBe("987654321");
  });

  it("ne supprime jamais la correspondance d'un autre site, même avec le bon identifiant", async () => {
    await creerCorrespondance(2, { eventName: "order_paid", conversionActionId: "555" });
    const [chezLautre] = await listerCorrespondances(2);

    expect(await supprimerCorrespondance(1, chezLautre.id)).toBe(false);
    expect(await listerCorrespondances(2)).toHaveLength(1);
  });
});

describe("etatSante", () => {
  it("décrit un site jamais configuré sans inventer d'erreur", async () => {
    expect(await etatSante(1)).toMatchObject({
      configured: false,
      enabled: false,
      customerId: null,
      mappings: 0,
      pending: 0,
      sent: 0,
      failed: 0,
      lastError: null,
      lastSentAt: null,
      oldestPendingAt: null,
    });
  });

  it("compte par état, remonte la dernière erreur et le plus vieux message en attente", async () => {
    await enregistrerReglages(1, { customerId: "2568911678", enabled: true });
    await creerCorrespondance(1, { eventName: "order_paid", conversionActionId: "987654321" });

    // Le journal appartient au drain (lot D) : on l'écrit ici en SQL brut, sans
    // importer son module, exactement comme la lecture le fera en production.
    await (sql as any).exec(`
      INSERT INTO "ads_conversion_outbox"
        ("site_id","business_event_id","conversion_action_id","click_id_type","click_id","occurred_at",
         "consent_ad_user_data","consent_ad_personalization","status","last_error","sent_at","created_at","updated_at")
      VALUES
        (1,'o1','987654321','gclid','A','2026-08-20 10:00:00','CONSENT_GRANTED','CONSENT_GRANTED','sent',NULL,'2026-08-20 10:05:00','2026-08-20 10:00:00','2026-08-20 10:05:00'),
        (1,'o2','987654321','gclid','B','2026-08-21 10:00:00','CONSENT_GRANTED','CONSENT_GRANTED','failed','403 compte hors périmètre',NULL,'2026-08-21 10:00:00','2026-08-21 10:06:00'),
        (1,'o3','987654321','gclid','C','2026-08-22 10:00:00','CONSENT_GRANTED','CONSENT_GRANTED','pending',NULL,NULL,'2026-08-22 09:00:00','2026-08-22 09:00:00'),
        (1,'o4','987654321','gclid','D','2026-08-23 10:00:00','CONSENT_GRANTED','CONSENT_GRANTED','pending',NULL,NULL,'2026-08-23 09:00:00','2026-08-23 09:00:00'),
        (2,'o5','555','gclid','E','2026-08-23 10:00:00','CONSENT_GRANTED','CONSENT_GRANTED','failed','autre site',NULL,'2026-08-23 09:00:00','2026-08-25 09:00:00')
    `);

    const etat = await etatSante(1);
    expect(etat).toMatchObject({ configured: true, enabled: true, mappings: 1, pending: 2, sent: 1, failed: 1 });
    // Le journal du site 2 ne doit teinter ni les compteurs ni la dernière
    // erreur, alors que la sienne est plus récente.
    expect(etat.lastError?.message).toBe("403 compte hors périmètre");
    expect(etat.lastSentAt).toContain("2026-08-20");
    // Le témoin d'un drain arrêté : le plus ancien message encore en attente.
    expect(etat.oldestPendingAt).toContain("2026-08-22");
  });

  // Ajouté par le lot D. Deux compteurs qui manquaient, tous deux sur des états
  // qui ne produisent AUCUNE erreur et ne se déduisent d'aucun autre chiffre.
  it("compte les écartées et les envois à valeur nulle", async () => {
    await enregistrerReglages(1, { customerId: "2568911678", enabled: true });

    await (sql as any).exec(`
      INSERT INTO "ads_conversion_outbox"
        ("site_id","business_event_id","conversion_action_id","click_id_type","click_id","occurred_at",
         "value","consent_ad_user_data","consent_ad_personalization","status","sent_at")
      VALUES
        (1,'z1','987654321','gclid','A','2026-08-20 10:00:00',42.90,'CONSENT_GRANTED','CONSENT_GRANTED','sent','2026-08-20 10:05:00'),
        (1,'z2','987654321','gclid','B','2026-08-20 10:00:00',NULL,'CONSENT_GRANTED','CONSENT_GRANTED','sent','2026-08-20 10:05:00'),
        (1,'z3','987654321','gclid','C','2026-08-20 10:00:00',0,'CONSENT_GRANTED','CONSENT_GRANTED','sent','2026-08-20 10:05:00'),
        (1,'z4','987654321','gclid','D','2026-08-20 10:00:00',NULL,'CONSENT_DENIED','CONSENT_DENIED','skipped',NULL),
        (2,'z5','555','gclid','E','2026-08-20 10:00:00',NULL,'CONSENT_GRANTED','CONSENT_GRANTED','sent','2026-08-20 10:05:00')
    `);

    const etat = await etatSante(1);
    expect(etat.sent).toBe(3);
    // 🔴 Deux des trois envois ne rapporteront aucun chiffre d'affaires à
    // Google, qui les comptera quand même : sans ce compteur, un ROAS faux ne
    // se déduit d'aucune ligne de l'état de santé. La valeur nulle et la valeur
    // zéro comptent pareil, elles ont le même effet.
    expect(etat.zeroValueSent).toBe(2);
    // Écartée par une règle métier : ni un succès, ni une panne.
    expect(etat.skipped).toBe(1);
    expect(etat.failed).toBe(0);
    // Et le site voisin ne teinte rien.
    expect(etat.pending).toBe(0);
  });

  // Ajouté par le lot D. Le seul témoin d'un drain arrêté, et il ne se confond
  // avec rien d'autre : une file qui grossit ne prouve rien (le report du drain
  // monte à 6 h), une échéance dépassée si.
  describe("oldestOverdueBy — un drain arrêté ne lève aucune erreur", () => {
    const enAttente = (businessEventId: string, echeance: string) =>
      (sql as any).query(
        `INSERT INTO "ads_conversion_outbox"
           ("site_id","business_event_id","conversion_action_id","click_id_type","click_id",
            "occurred_at","consent_ad_user_data","consent_ad_personalization","status","next_attempt_at")
         VALUES (1,$1,'987654321','gclid','A','2026-08-20 10:00:00','CONSENT_GRANTED','CONSENT_GRANTED','pending',$2)`,
        [businessEventId, echeance]
      );

    it("ne signale RIEN quand la seule ligne en attente a une échéance future", async () => {
      // Le cas qu'un seuil sur l'âge de la ligne aurait pris pour une panne :
      // un réessai normal, dont l'échéance est simplement repoussée.
      await enAttente("futur", "2099-01-01 00:00:00");
      const etat = await etatSante(1);
      expect(etat.pending).toBe(1);
      expect(etat.oldestOverdueBy).toBeNull();
    });

    it("mesure le retard de la ligne la plus en retard, en secondes", async () => {
      await enAttente("futur", "2099-01-01 00:00:00");
      await enAttente("retard_court", "2026-08-29 11:00:00");
      await enAttente("retard_long", "2026-08-20 10:00:00");

      const etat = await etatSante(1);
      // Le retard se compte depuis MAINTENANT, donc on ne peut pas l'égaler à
      // une constante ; on vérifie qu'il correspond bien à la ligne la PLUS en
      // retard, à la seconde près, et pas à la plus récente ni à une moyenne.
      const attendu = Math.floor((Date.now() - Date.parse("2026-08-20T10:00:00Z")) / 1000);
      expect(etat.oldestOverdueBy).not.toBeNull();
      expect(Math.abs((etat.oldestOverdueBy as number) - attendu)).toBeLessThan(5);
    });

    it("ne compte ni les envoyées, ni les échouées, ni les écartées", async () => {
      // Ces trois états sont terminaux : leur `next_attempt_at` est figé dans le
      // passé pour toujours, et les compter ferait hurler l'alerte à vie sur un
      // site parfaitement sain.
      for (const [id, etat] of [["s", "sent"], ["f", "failed"], ["k", "skipped"]]) {
        await (sql as any).query(
          `INSERT INTO "ads_conversion_outbox"
             ("site_id","business_event_id","conversion_action_id","click_id_type","click_id",
              "occurred_at","consent_ad_user_data","consent_ad_personalization","status","next_attempt_at")
           VALUES (1,$1,'987654321','gclid','A','2026-08-20 10:00:00','CONSENT_GRANTED','CONSENT_GRANTED',$2,'2026-08-20 10:00:00')`,
          [id, etat]
        );
      }
      expect((await etatSante(1)).oldestOverdueBy).toBeNull();
    });

    it("🔴 ne dépend pas du fuseau de la base", async () => {
      // Sans l'ancrage `now() AT TIME ZONE 'UTC'`, comparer un `timestamptz`
      // avec une colonne `timestamp` sans fuseau la convertit dans le fuseau de
      // la SESSION : les lignes paraîtraient en retard du décalage, et l'alerte
      // hurlerait en permanence sans qu'aucune erreur ne l'explique.
      //
      // ⚠️ L'échéance est délibérément PROCHE (une heure), pas en 2099 : une
      // échéance lointaine résiste à n'importe quel décalage, donc un test posé
      // sur elle reste vert quand on retire l'ancrage. C'est l'erreur que ce
      // test a d'abord commise, attrapée en cassant la règle exprès.
      const dansUneHeure = new Date(Date.now() + 3_600_000).toISOString().replace("T", " ").slice(0, 19);
      const enRetardDeDeuxHeures = new Date(Date.now() - 7_200_000).toISOString().replace("T", " ").slice(0, 19);
      await enAttente("bientot", dansUneHeure);

      try {
        // +02:00, puis +14:00 : les deux dépassent l'heure d'échéance, donc les
        // deux fabriqueraient une fausse alerte.
        for (const fuseau of ["Europe/Paris", "Pacific/Kiritimati"]) {
          await (sql as any).exec(`SET TIME ZONE '${fuseau}'`);
          expect(await etatSante(1).then(e => e.oldestOverdueBy), fuseau).toBeNull();
        }

        // Et le SENS inverse : une ligne réellement en retard doit l'être de la
        // bonne durée, pas de la durée plus le décalage du fuseau.
        await enAttente("vraiment_en_retard", enRetardDeDeuxHeures);
        for (const fuseau of ["Europe/Paris", "Pacific/Kiritimati", "UTC"]) {
          await (sql as any).exec(`SET TIME ZONE '${fuseau}'`);
          const retard = await etatSante(1).then(e => e.oldestOverdueBy);
          expect(Math.abs((retard as number) - 7200), fuseau).toBeLessThan(5);
        }
      } finally {
        await (sql as any).exec(`SET TIME ZONE 'UTC'`);
      }
    });
  });
});

describe("validerNomEvenement", () => {
  it("rogne les espaces et accepte un nom d'événement ordinaire", () => {
    expect(validerNomEvenement("  order_paid ")).toEqual({ ok: true, valeur: "order_paid" });
  });

  it.each([[undefined], [null], [""], ["   "], [42], [{}]])("refuse %o comme nom d'événement", brut => {
    // 🔴 Une correspondance sans nom d'événement s'insère parfaitement (la
    // colonne est du `text`), et ne correspond ENSUITE à aucun événement réel :
    // les conversions du client ne partent jamais, sans qu'aucune erreur ne soit
    // levée nulle part. C'est le défaut le plus cher du module, parce qu'il
    // ressemble à un fonctionnement normal jusqu'à ce qu'on compte l'argent.
    expect(validerNomEvenement(brut)).toMatchObject({ ok: false });
  });

  it("refuse un nom au-delà de 128 caractères", () => {
    // La colonne est du `text` : Postgres accepterait sans broncher. La borne
    // est donc à poser ici ou nulle part, et sans elle un appelant peut écrire
    // des mégaoctets dans la table par l'API.
    expect(validerNomEvenement("a".repeat(128))).toMatchObject({ ok: true });
    expect(validerNomEvenement("a".repeat(129))).toMatchObject({ ok: false });
    expect(validerNomEvenement("a".repeat(129))).toMatchObject({
      message: expect.stringContaining("128"),
    });
  });
});

describe("les refus qui n'atteignent jamais la base", () => {
  /** Chaque saisie doit être refusée AVANT toute écriture. */
  it.each([
    ["nom d'événement absent", { conversionActionId: "987654321" }],
    ["nom d'événement trop long", { eventName: "a".repeat(200), conversionActionId: "987654321" }],
    ["action de conversion absente", { eventName: "order_paid" }],
    ["étiquette de tag prise pour une action", { eventName: "order_paid", conversionActionId: "AW-1841/cL48" }],
    ["devise inventée", { eventName: "order_paid", conversionActionId: "987654321", currency: "EURO" }],
    ["devise numérique", { eventName: "order_paid", conversionActionId: "987654321", currency: 978 }],
    ["valeur négative", { eventName: "order_paid", conversionActionId: "987654321", defaultValue: -1 }],
    ["valeur illisible", { eventName: "order_paid", conversionActionId: "987654321", defaultValue: "quarante" }],
    [
      "valeur au-delà de numeric(14,2)",
      { eventName: "order_paid", conversionActionId: "987654321", defaultValue: 1e12 },
    ],
  ])("creerCorrespondance refuse : %s", async (_cas, entree) => {
    const resultat = await creerCorrespondance(1, entree as any);

    expect(resultat).toMatchObject({ ok: false });
    // Un refus doit être un refus, pas un conflit : l'appelant HTTP en tire un
    // 400 et non un 409, donc « corrige ta saisie » et non « c'est déjà fait ».
    expect((resultat as { conflit?: true }).conflit).toBeUndefined();
    // Et surtout, rien n'a été écrit. Une ligne à moitié valide insérée puis
    // refusée par la contrainte laisserait une séquence trouée et un message
    // Postgres brut à la place d'une explication.
    expect(await listerCorrespondances(1)).toHaveLength(0);
  });

  it("une valeur hors bornes est refusée ici, pas par Postgres", async () => {
    // `numeric(14,2)` déborde à partir de 10^12. Sans le contrôle, l'appelant
    // reçoit un « numeric field overflow » en 500 au lieu d'un message qui lui
    // dit quoi corriger — et le module a l'air en panne alors qu'il va bien.
    expect(validerValeurParDefaut(99_999_999_999.99)).toMatchObject({ ok: true });
    expect(validerValeurParDefaut(100_000_000_000)).toMatchObject({ ok: false });
    expect(validerValeurParDefaut(100_000_000_000)).toMatchObject({
      message: expect.stringContaining("numeric(14,2)"),
    });
  });

  it("refuse un testMode qui n'est pas un booléen, comme enabled", async () => {
    // Même piège que `enabled`, et conséquence inverse : `testMode: "false"`
    // accepté tel quel vaut `true`, donc le site passe en mode d'essai et PLUS
    // AUCUNE conversion réelle ne part. Silencieux, et exactement le contraire
    // de ce que l'utilisateur croyait cocher.
    await enregistrerReglages(1, { customerId: "2568911678", testMode: true });
    expect(await enregistrerReglages(1, { testMode: "false" })).toMatchObject({ ok: false });
    expect((await lireReglages(1))!.testMode).toBe(true);
  });
});

/* ─────── Lot G : distinguer « calme », « cassé » et « jamais tourné » ────── */

/**
 * 🔴 Ce que ce bloc protège, et pourquoi il compte plus que le stockage.
 *
 * Trois situations produisaient le MÊME écran, « 0 en attente, 0 envoyé » : la
 * tâche planifiée qui ne tourne pas, le site sans trafic, et le site dont chaque
 * événement est écarté avant d'entrer au journal. La première et la troisième
 * sont des pannes ; la deuxième est normale. Les confondre, c'est exactement le
 * défaut « répond OK sans rien faire » que tout ce module existe pour ne pas
 * fabriquer — et il serait resté dans notre propre travail.
 */
function bilan(sur: Partial<import("./settings.js").DernierBalayage> = {}) {
  return {
    at: "2026-08-29 12:00:00",
    examined: 0,
    recorded: 0,
    alreadyKnown: 0,
    duplicates: 0,
    skippedNoConsent: 0,
    skippedNoClick: 0,
    errors: 0,
    truncated: false,
    unmappedEvents: 0,
    unmappedTopNames: [],
    ...sur,
  };
}

describe("classerBalayage", () => {
  it("aucune trace = jamais tourné, et c'est le témoin d'un cron mort", () => {
    expect(classerBalayage(null, 3)).toBe("never_ran");
  });

  it("« jamais tourné » passe DEVANT « aucune correspondance »", () => {
    // Le plus grave d'abord : un site sans correspondance se répare en trois
    // clics, une tâche planifiée morte empêche TOUS les sites de produire.
    expect(classerBalayage(null, 0)).toBe("never_ran");
  });

  it("activé sans correspondance : rien ne peut sortir, par construction", () => {
    expect(classerBalayage(bilan(), 0)).toBe("no_mappings");
  });

  it("a tourné, rien vu : site calme", () => {
    expect(classerBalayage(bilan(), 2)).toBe("idle");
  });

  it("🔴 a vu du trafic et n'a rien inscrit : configuration cassée, PAS un site calme", () => {
    expect(classerBalayage(bilan({ examined: 40, skippedNoConsent: 40 }), 2)).toBe("all_discarded");
  });

  it("🔴 du trafic uniquement sous des noms non couverts est AUSSI une configuration cassée", () => {
    // La faute de frappe dans un nom d'événement : la requête principale ne lit
    // rien, tous les compteurs valent zéro, et sans ce cas l'écran dirait « calme ».
    expect(classerBalayage(bilan({ examined: 0, unmappedEvents: 120 }), 2)).toBe("all_discarded");
  });

  it("inscrit au moins une conversion : le module produit", () => {
    expect(classerBalayage(bilan({ examined: 10, recorded: 3 }), 2)).toBe("producing");
  });

  it("les cinq états sont deux à deux distincts", () => {
    const verdicts = [
      classerBalayage(null, 3),
      classerBalayage(bilan(), 0),
      classerBalayage(bilan(), 2),
      classerBalayage(bilan({ examined: 40 }), 2),
      classerBalayage(bilan({ examined: 40, recorded: 1 }), 2),
    ];
    expect(new Set(verdicts).size).toBe(5);
  });
});

describe("etatSante : le dernier balayage", () => {
  it("sans passage, l'état le DIT au lieu d'afficher un site calme", async () => {
    await enregistrerReglages(1, { customerId: "2568911678", enabled: true });
    await creerCorrespondance(1, { eventName: "order_confirmed", conversionActionId: "987654321" });

    const etat = await etatSante(1);

    expect(etat.lastScan).toBeNull();
    expect(etat.scanVerdict).toBe("never_ran");
    // La forme existante n'a pas bougé : trois surfaces clientes la consomment.
    expect(etat.pending).toBe(0);
    expect(etat.sent).toBe(0);
  });

  it("expose le bilan du dernier passage, motifs compris", async () => {
    await enregistrerReglages(1, { customerId: "2568911678", enabled: true });
    await creerCorrespondance(1, { eventName: "order_confirmed", conversionActionId: "987654321" });
    await (sql as any).query(
      `INSERT INTO ads_scan_state
        (site_id, last_run_at, events_examined, recorded, skipped_no_consent, skipped_no_click,
         unmapped_events, unmapped_top_names)
       VALUES (1, '2026-08-29T12:00:00Z'::timestamp, 40, 0, 40, 0, 5, 'cart_viewed, search_performed')`
    );

    const etat = await etatSante(1);

    expect(etat.scanVerdict).toBe("all_discarded");
    expect(etat.lastScan).toMatchObject({ examined: 40, recorded: 0, skippedNoConsent: 40 });
    expect(etat.lastScan?.unmappedTopNames).toEqual(["cart_viewed", "search_performed"]);
  });

  it("un site qui produit est classé comme tel", async () => {
    await enregistrerReglages(1, { customerId: "2568911678", enabled: true });
    await creerCorrespondance(1, { eventName: "order_confirmed", conversionActionId: "987654321" });
    await (sql as any).query(
      `INSERT INTO ads_scan_state (site_id, last_run_at, events_examined, recorded)
       VALUES (1, '2026-08-29T12:00:00Z'::timestamp, 10, 4)`
    );

    expect((await etatSante(1)).scanVerdict).toBe("producing");
  });

  it("le bilan d'un site ne fuit pas sur un autre", async () => {
    await enregistrerReglages(1, { customerId: "2568911678", enabled: true });
    await enregistrerReglages(2, { customerId: "2568911678", enabled: true });
    await (sql as any).query(
      `INSERT INTO ads_scan_state (site_id, last_run_at, events_examined, recorded)
       VALUES (1, '2026-08-29T12:00:00Z'::timestamp, 10, 4)`
    );

    expect((await etatSante(2)).lastScan).toBeNull();
  });
});
