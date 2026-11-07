/**
 * Ce que ce fichier protège, et pourquoi il tourne sur un vrai Postgres.
 *
 * Le journal de conversions a une particularité désagréable : **presque tous ses
 * défauts sont muets**. Une conversion envoyée deux fois reçoit deux HTTP 200 ;
 * une conversion dont le clic a cent jours reçoit un HTTP 200 et n'est jamais
 * comptée ; une conversion partie sans consentement reçoit un HTTP 200. Il n'y a
 * ni erreur, ni log, ni alerte à attendre — seulement un chiffre faux dans le
 * tableau de bord Ads, sur lequel les enchères se règlent.
 *
 * D'où deux partis pris :
 *
 *  - **PGlite plutôt qu'une base simulée.** Ce qui compte est que la base
 *    refuse, pas que le TypeScript le prétende. Le DDL est celui de la
 *    migration 0016, recopié ; le rejouer vérifie accessoirement qu'il
 *    s'applique sur une base vierge. Motif repris de `schema.test.ts`, helper
 *    `echoueSur()` compris ;
 *  - **un fuseau volontairement décalé.** `process.env.TZ` est posé sur
 *    `America/New_York` (−04:00) AVANT toute construction de date. Un
 *    `new Date("2026-08-29 10:00:00")` réintroduit quelque part rendrait alors
 *    `14:00:00Z` au lieu de `10:00:00Z`, et la suite rougit. Sous un `TZ=UTC` de
 *    CI, ce même défaut serait invisible : c'est exactement la raison de forcer
 *    le fuseau ici plutôt que de faire confiance à l'environnement.
 */
process.env.TZ = "America/New_York";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

/**
 * `lireReglages()` appartient au lot E et parle à la VRAIE base. Le drain s'en
 * sert désormais plutôt que d'avoir sa propre lecture de `ads_site_settings` :
 * deux lectures concurrentes de la même table finissent par diverger, et l'écart
 * ne se voit qu'en production.
 *
 * On le rebranche donc sur la PGlite de ce fichier. Ce qui est prouvé ici, c'est
 * que le drain PASSE bien par cette fonction ; ce que la fonction lit est
 * couvert par `settings.test.ts`.
 */
const pgliteTest = vi.hoisted(() => ({ client: null as any }));
vi.mock("./settings.js", () => ({
  lireReglages: async (siteId: number) => {
    const r = await pgliteTest.client.query(
      `SELECT site_id, customer_id, enabled, test_mode FROM ads_site_settings WHERE site_id = $1`,
      [siteId],
    );
    const l = r.rows[0];
    return l
      ? { siteId: l.site_id, customerId: l.customer_id, enabled: l.enabled, testMode: l.test_mode }
      : null;
  },
}));

import {
  BAIL_MS,
  ETAT,
  MAX_TENTATIVES,
  MOTIF,
  cleIdempotence,
  credentialsDepuisEnv,
  depuisColonne,
  drainerConversions,
  enregistrerConversion,
  evaluerEnvoi,
  reclamerLot,
  reportProchaineTentative,
  resoudreValeurParDefaut,
  versColonne,
  versLigne,
  type BaseOutbox,
  type ConversionAEnregistrer,
  type LigneOutbox,
  type ReglagesSite,
} from "./outbox.js";
import { AdsIngestError, type IngestResult } from "./dataManager.js";

const client = new PGlite();
pgliteTest.client = client;
const db = drizzle(client) as unknown as BaseOutbox;

/**
 * DDL de la migration 0016, recopié : le rejouer ici vérifie accessoirement
 * qu'il s'applique sur une base vierge. `click_at` (l'âge des 90 jours porte sur
 * le CLIC, pas sur la conversion) et l'état `skipped` (une règle métier qui
 * refuse n'est pas une panne) y sont depuis la demande du lot D.
 */
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
  CONSTRAINT "ads_conversion_outbox_click_id_type_check" CHECK ("click_id_type" IN ('gclid', 'gbraid', 'wbraid')),
  CONSTRAINT "ads_conversion_outbox_click_id_check" CHECK ("click_id" <> '')
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
  CONSTRAINT "ads_conversion_mappings_site_event_unique" UNIQUE("site_id","event_name")
);

CREATE INDEX "ads_conversion_outbox_drain_idx" ON "ads_conversion_outbox" USING btree ("next_attempt_at") WHERE status = 'pending';
`;

const MAINTENANT = new Date("2026-08-29T12:00:00.000Z");
const jours = (n: number) => new Date(MAINTENANT.getTime() - n * 86_400_000);

function conversion(sur: Partial<ConversionAEnregistrer> = {}): ConversionAEnregistrer {
  return {
    siteId: 1,
    businessEventId: "order_4711",
    conversionActionId: "987654321",
    clickIdType: "gclid",
    clickId: "Cj0KCQjwReel",
    occurredAt: new Date("2026-08-29T10:00:00.000Z"),
    clickAt: jours(3),
    value: 42.9,
    currency: "EUR",
    consentAdUserData: "CONSENT_GRANTED",
    consentAdPersonalization: "CONSENT_GRANTED",
    ...sur,
  };
}

function ligne(sur: Partial<LigneOutbox> = {}): LigneOutbox {
  return {
    id: 1,
    siteId: 1,
    businessEventId: "order_4711",
    conversionActionId: "987654321",
    clickIdType: "gclid",
    clickId: "Cj0KCQjwReel",
    occurredAt: new Date("2026-08-29T10:00:00.000Z"),
    clickAt: jours(3),
    value: 42.9,
    currency: "EUR",
    consentAdUserData: "CONSENT_GRANTED",
    consentAdPersonalization: "CONSENT_GRANTED",
    attempts: 1,
    ...sur,
  };
}

const reglagesActifs: ReglagesSite = {
  siteId: 1,
  customerId: "2568911678",
  enabled: true,
  testMode: false,
};

const credentials = { clientId: "c", clientSecret: "s", refreshToken: "r" };

/** Faux client réseau : on capture ce qui partirait, on ne joint jamais Google. */
function faussIngest(reponse: IngestResult | Error = { requestId: "req-1", eventCount: 1, validateOnly: false }) {
  const appels: { destination: unknown; evenements: any[] }[] = [];
  const fn = vi.fn(async (_creds: unknown, destination: unknown, evenements: any[]) => {
    appels.push({ destination, evenements });
    if (reponse instanceof Error) throw reponse;
    return { ...reponse, eventCount: evenements.length };
  });
  return { fn: fn as any, appels };
}

/**
 * Lecture brute d'une ligne, horodatages rendus par `to_char` en UTC explicite.
 *
 * 🔴 Ce n'est pas une coquetterie : un `SELECT *` nu rend un `Date` que PGlite a
 * déjà parsé dans le fuseau du PROCESSUS — `10:00:00` en base devient
 * `14:00:00Z` ici. C'est ce que ce fichier a mis au jour, et c'est pour cela que
 * le module rend lui aussi ses horodatages par `to_char`. Le test « le pilote
 * ment » plus bas fige le constat.
 */
const COLONNES = `id, site_id, business_event_id, conversion_action_id, click_id_type, click_id,
  value, currency, consent_ad_user_data, consent_ad_personalization, status, attempts,
  last_error, google_request_id,
  to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
  to_char(click_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS click_at,
  to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS next_attempt_at,
  to_char(sent_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sent_at`;

async function lire(id = 1) {
  const r: any = await client.query(
    `SELECT ${COLONNES} FROM ads_conversion_outbox WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

async function toutes() {
  const r: any = await client.query(`SELECT ${COLONNES} FROM ads_conversion_outbox ORDER BY id`);
  return r.rows;
}

const reglagesInjectes = (r: ReglagesSite | null) => async () =>
  r ? new Map([[r.siteId, r]]) : new Map<number, ReglagesSite>();

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
// 🔴 Le fuseau de la SESSION Postgres est décalé lui aussi. Une colonne
// `timestamp` sans fuseau alimentée par `DEFAULT now()` prendrait alors
// l'heure murale de New York, soit quatre heures d'écart avec ce que le drain
// compare. Décaler la session ici fait rougir tout endroit du module qui
// s'en remettrait à `now()` plutôt que d'écrire un instant UTC explicite.
await client.exec(`SET TIME ZONE 'America/New_York'`);

beforeEach(async () => {
  await client.exec(
    `TRUNCATE "ads_conversion_outbox", "ads_conversion_mappings", "ads_site_settings", "sites" RESTART IDENTITY CASCADE`,
  );
  await client.exec(`INSERT INTO "sites" ("site_id","name") VALUES (1,'asd'), (2,'autre')`);
});

/* ═══════════════════════════════ Fuseau ═══════════════════════════════════ */

describe("fuseau horaire — le décalage qui ne se voit pas", () => {
  it("n'écrit jamais autre chose qu'un instant UTC terminé par Z", () => {
    // Un décalage `+02:00` serait retenu tel quel par Postgres (heure murale du
    // littéral), donc deux heures d'erreur silencieuse dans la colonne.
    expect(versColonne(new Date("2026-08-29T10:00:00Z"))).toBe("2026-08-29T10:00:00.000Z");
    expect(versColonne("2026-08-29T12:00:00+02:00")).toBe("2026-08-29T10:00:00.000Z");
    expect(() => versColonne("pas une date")).toThrow();
  });

  it("relit une colonne sans fuseau comme de l'UTC, pas comme de l'heure locale", () => {
    const instant = depuisColonne("2026-08-29 10:00:00");
    expect(instant.toISOString()).toBe("2026-08-29T10:00:00.000Z");

    // 🔴 Le contrôle qui donne son sens au précédent : sous ce fuseau, la voie
    // naïve donne un AUTRE résultat. Si cette assertion tombait, c'est que le
    // test tourne en UTC et ne prouve plus rien — il faudrait le savoir.
    expect(new Date("2026-08-29 10:00:00").toISOString()).toBe("2026-08-29T14:00:00.000Z");
    expect(instant.toISOString()).not.toBe(new Date("2026-08-29 10:00:00").toISOString());
  });

  it("le pilote ment : une colonne sans fuseau lue nue revient décalée", async () => {
    // 🔴 Constat mesuré, et raison d'être du `to_char` dans tout le module. La
    // base contient bien 10:00 ; c'est le PILOTE qui, en construisant le `Date`,
    // applique le fuseau du processus. Aucune correction n'est possible après
    // coup, l'information est perdue.
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const nu: any = await client.query(`SELECT occurred_at FROM ads_conversion_outbox WHERE id = 1`);
    expect(nu.rows[0].occurred_at instanceof Date).toBe(true);
    expect(nu.rows[0].occurred_at.toISOString()).toBe("2026-08-29T14:00:00.000Z");

    // La même colonne, rendue par `to_char` : l'instant réel.
    const via: any = await client.query(
      `SELECT to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t FROM ads_conversion_outbox WHERE id = 1`,
    );
    expect(depuisColonne(via.rows[0].t).toISOString()).toBe("2026-08-29T10:00:00.000Z");
  });

  it("la requête du drain ne lit JAMAIS une colonne d'horodatage nue", async () => {
    // 🔴 Ce test existe parce que PGlite ne suffit pas à prouver la protection :
    // par le chemin drizzle, il rend déjà des chaînes, donc une colonne nue y
    // passerait au vert alors qu'elle décalerait tout en production. On inspecte
    // donc le SQL émis, ce qui est le seul contrôle capable de rougir ici.
    const sqlVus: string[] = [];
    const espion: BaseOutbox = {
      async execute(requete: any) {
        sqlVus.push(String(requete?.queryChunks?.map((c: any) => c?.value ?? "").join("") ?? requete));
        return [];
      },
    };
    await reclamerLot(espion, MAINTENANT);

    const requete = sqlVus.join(" ").replace(/\s+/g, " ");
    expect(requete).toContain("to_char(o.occurred_at");
    expect(requete).toContain("to_char(o.click_at");
    // Et pas de `RETURNING o.*`, qui ramènerait les colonnes nues sans qu'on
    // les nomme — la façon la plus facile de réintroduire le défaut.
    expect(requete).not.toContain("RETURNING o.*");
  });

  it("refuse bruyamment un horodatage que le pilote a déjà parsé", () => {
    // Un `Date` venu d'une colonne sans fuseau porte le décalage du processus,
    // et rien ne permet de le distinguer d'un instant juste. Mieux vaut casser
    // au premier drain que décaler l'attribution pendant des semaines.
    const brute = {
      id: 1,
      site_id: 1,
      business_event_id: "x",
      conversion_action_id: "1",
      click_id_type: "gclid",
      click_id: "c",
      occurred_at: new Date("2026-08-29T10:00:00Z"),
      click_at: "2026-08-29T09:00:00.000Z",
      value: null,
      currency: "EUR",
      consent_ad_user_data: "CONSENT_GRANTED",
      consent_ad_personalization: "CONSENT_GRANTED",
      attempts: 0,
    };
    expect(() => versLigne(brute)).toThrow(/occurred_at.*to_char/s);
  });

  it("garde l'instant intact sur un aller-retour en base, malgré session et process décalés", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const [l] = await reclamerLot(db, MAINTENANT);

    expect(l.occurredAt.toISOString()).toBe("2026-08-29T10:00:00.000Z");
    expect(l.clickAt.toISOString()).toBe(jours(3).toISOString());
  });

  it("date la ligne en UTC explicite, jamais avec le now() de la session", async () => {
    // Sans `next_attempt_at` posé explicitement, `DEFAULT now()` écrirait
    // « 08:00 » (heure de New York) pour un instant de 12:00 UTC. La ligne
    // deviendrait drainable quatre heures trop tôt — ou trop tard selon le
    // signe du décalage — sans qu'aucune erreur ne le signale.
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const brute = await lire();
    expect(depuisColonne(brute.next_attempt_at).toISOString()).toBe(MAINTENANT.toISOString());

    // Et elle est effectivement due à cet instant-là, ni avant ni après.
    expect(await reclamerLot(db, new Date(MAINTENANT.getTime() - 1000))).toHaveLength(0);
    expect(await reclamerLot(db, MAINTENANT)).toHaveLength(1);
  });
});

/* ══════════════════════════ Enregistrement ════════════════════════════════ */

describe("enregistrerConversion — idempotent par construction", () => {
  it("crée la ligne au premier appel", async () => {
    const r = await enregistrerConversion(conversion(), db, MAINTENANT);
    expect(r).toEqual({ cree: true, id: 1 });
    expect(await toutes()).toHaveLength(1);
  });

  it("ne crée rien et ne lève pas au rejeu, même avec des données différentes", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);

    // Le cas réel : un webhook redélivré. Le triplet est le même, le reste non.
    const r = await enregistrerConversion(
      conversion({ clickId: "Cj0KCQjwAUTRE", value: 99 }),
      db,
      MAINTENANT,
    );

    expect(r).toEqual({ cree: false, id: null });
    const lignes = await toutes();
    expect(lignes).toHaveLength(1);
    expect(lignes[0].click_id).toBe("Cj0KCQjwReel");
  });

  it("laisse passer ce qui diffère par le site, l'événement ou l'action", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    await enregistrerConversion(conversion({ siteId: 2 }), db, MAINTENANT);
    await enregistrerConversion(conversion({ businessEventId: "order_4712" }), db, MAINTENANT);
    await enregistrerConversion(conversion({ conversionActionId: "1" }), db, MAINTENANT);
    expect(await toutes()).toHaveLength(4);
  });

  it("fait de la clé du journal le transactionId envoyé à Google", () => {
    // Si ces deux-là divergeaient, notre journal dédupliquerait et Google non :
    // un rejeu compterait deux conversions, sans aucune erreur.
    expect(cleIdempotence(ligne())).toBe("1:order_4711:987654321");
  });
});

/* ═══════════════════════ Valeur : le ROAS silencieux ══════════════════════ */

describe("repli de valeur — le seul défaut qu'aucun contrôle d'envoi n'attrape", () => {
  const correspondance = (sur: Record<string, unknown> = {}) =>
    client.query(
      `INSERT INTO ads_conversion_mappings (site_id, event_name, conversion_action_id, default_value, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        sur.siteId ?? 1,
        sur.eventName ?? "order_paid",
        sur.conversionActionId ?? "987654321",
        "defaultValue" in sur ? sur.defaultValue : "19.90",
        sur.currency ?? "EUR",
      ],
    );

  it("reprend la valeur et la devise par défaut quand l'appelant n'en fournit pas", async () => {
    // 🔴 Sans ce repli, la conversion part à 0. Google l'ACCEPTE et la COMPTE :
    // le ROAS du compte devient faux, et aucun compteur d'erreur ne bouge. Les
    // protections du module portent sur l'envoi, pas sur son contenu — celle-ci
    // est la seule qui couvre le contenu.
    await correspondance({ defaultValue: "19.90", currency: "USD" });
    await enregistrerConversion(
      { ...conversion(), eventName: "order_paid", value: undefined, currency: undefined },
      db,
      MAINTENANT,
    );

    const l = await lire();
    expect(Number(l.value)).toBe(19.9);
    expect(l.currency).toBe("USD");
  });

  it("laisse passer une conversion légitimement sans valeur, sans la bloquer", async () => {
    // Un formulaire de contact n'a pas de montant. La refuser ferait perdre une
    // vraie conversion ; on l'enregistre, on l'envoie, et `etatSante` la compte.
    await correspondance({ eventName: "contact", defaultValue: null });
    const r = await enregistrerConversion(
      { ...conversion(), eventName: "contact", value: undefined },
      db,
      MAINTENANT,
    );
    expect(r.cree).toBe(true);
    expect((await lire()).value).toBeNull();

    const ingest = faussIngest();
    const bilan = await drainerConversions({
      base: db,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials,
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });
    expect(bilan.envoyees).toBe(1);
    expect(ingest.appels[0].evenements[0].value).toBe(0);
  });

  it("n'écrase JAMAIS une valeur fournie, zéro compris", async () => {
    // `null` et `0` sont des décisions de l'appelant, pas des absences. Les
    // remplacer par un défaut inventerait un chiffre d'affaires.
    await correspondance({ defaultValue: "19.90" });
    await enregistrerConversion({ ...conversion(), eventName: "order_paid", value: 0 }, db, MAINTENANT);
    await enregistrerConversion(
      { ...conversion(), businessEventId: "o2", eventName: "order_paid", value: null },
      db,
      MAINTENANT,
    );

    expect(Number((await lire(1)).value)).toBe(0);
    expect((await lire(2)).value).toBeNull();
  });

  it("refuse de deviner quand deux événements visent la même action de conversion", async () => {
    // La contrainte du dépôt porte sur (site, event_name) : deux événements
    // PEUVENT viser la même action avec des défauts différents. Choisir au
    // hasard fabriquerait un montant faux et plausible — pire que zéro, qui se
    // voit dans `etatSante`.
    await correspondance({ eventName: "order_paid", defaultValue: "19.90" });
    await correspondance({ eventName: "signup", defaultValue: "5.00" });

    const sansNom = await resoudreValeurParDefaut(db, 1, { conversionActionId: "987654321" });
    expect(sansNom.value).toBeNull();

    // Avec le nom de l'événement, aucune ambiguïté.
    const avecNom = await resoudreValeurParDefaut(db, 1, {
      eventName: "signup",
      conversionActionId: "987654321",
    });
    expect(avecNom.value).toBe(5);
  });

  it("se rabat sur l'action de conversion quand elle ne désigne qu'une correspondance", async () => {
    await correspondance({ eventName: "order_paid", defaultValue: "19.90" });
    const r = await resoudreValeurParDefaut(db, 1, { conversionActionId: "987654321" });
    expect(r.value).toBe(19.9);
  });

  it("ne mélange pas les correspondances de deux sites", async () => {
    await correspondance({ siteId: 2, eventName: "order_paid", defaultValue: "99.00" });
    const r = await resoudreValeurParDefaut(db, 1, {
      eventName: "order_paid",
      conversionActionId: "987654321",
    });
    expect(r.value).toBeNull();
  });
});

/* ════════════════════════════ Règles métier ═══════════════════════════════ */

describe("evaluerEnvoi — les quatre règles qui décident avant le réseau", () => {
  it("laisse partir une conversion nominale", () => {
    expect(evaluerEnvoi(ligne(), reglagesActifs, MAINTENANT)).toEqual({ envoyer: true });
  });

  it("règle 1 — un site non activé n'envoie rien", () => {
    const v = evaluerEnvoi(ligne(), { ...reglagesActifs, enabled: false }, MAINTENANT);
    expect(v).toMatchObject({ envoyer: false, motif: MOTIF.siteDesactive });
  });

  it("règle 2 — le consentement se décide ici, pas chez Google", () => {
    // Mesuré : Google répond 200 à un `CONSENT_DENIED`. S'en remettre à lui
    // reviendrait à exporter quand même.
    for (const etat of ["CONSENT_DENIED", "CONSENT_UNSPECIFIED", ""]) {
      const v = evaluerEnvoi(ligne({ consentAdUserData: etat }), reglagesActifs, MAINTENANT);
      expect(v, `consentement « ${etat} »`).toMatchObject({
        envoyer: false,
        motif: MOTIF.consentementRefuse,
      });
    }
  });

  it("règle 3 — un clic de plus de 90 jours ne part pas", () => {
    // 🔴 Mesuré le 2026-08-29 : un clic de 120 jours reçoit un HTTP 200 et n'est
    // JAMAIS compté. Sans cette borne, le journal afficherait des succès qui ne
    // produisent rien, avec un compteur d'échecs à zéro.
    expect(evaluerEnvoi(ligne({ clickAt: jours(89) }), reglagesActifs, MAINTENANT)).toEqual({
      envoyer: true,
    });
    expect(evaluerEnvoi(ligne({ clickAt: jours(91) }), reglagesActifs, MAINTENANT)).toMatchObject({
      envoyer: false,
      motif: MOTIF.clicTropVieux,
    });
  });

  it("règle 3 — la borne porte sur le CLIC, pas sur la conversion", () => {
    // Le scénario qui rend `click_at` indispensable, et qu'aucune autre colonne
    // ne permet de voir : la conversion a été enregistrée hier avec un clic de
    // 88 jours (l'attribution l'autorisait), le drain a échoué quelques jours,
    // et le clic est sorti de la fenêtre PENDANT l'attente. `occurred_at` est
    // récent : s'y fier laisserait partir une conversion jamais comptée.
    const vieilli = ligne({ occurredAt: jours(1), clickAt: jours(95) });
    expect(evaluerEnvoi(vieilli, reglagesActifs, MAINTENANT)).toMatchObject({
      envoyer: false,
      motif: MOTIF.clicTropVieux,
    });
  });

  it("règle 4 — le mode d'essai ne laisse partir que les identifiants TEST_", () => {
    const essai = { ...reglagesActifs, testMode: true };
    // Un vrai identifiant depuis une recette créerait une VRAIE conversion sur
    // le compte du client, impossible à retirer une fois comptée.
    expect(evaluerEnvoi(ligne(), essai, MAINTENANT)).toMatchObject({
      envoyer: false,
      motif: MOTIF.essaiAvecVraiClic,
    });
    expect(evaluerEnvoi(ligne({ clickId: "TEST_abc" }), essai, MAINTENANT)).toEqual({ envoyer: true });
  });

  it("règle 4 — et la production ne laisse pas partir un identifiant de recette", () => {
    // Sens inverse, gardé aussi : un `TEST_…` en production est un 200 sans
    // effet, donc une ligne `sent` qui ment, et le signe qu'un jeu d'essai a
    // fui dans les données réelles.
    expect(evaluerEnvoi(ligne({ clickId: "TEST_abc" }), reglagesActifs, MAINTENANT)).toMatchObject({
      envoyer: false,
      motif: MOTIF.productionAvecClicDEssai,
    });
  });
});

describe("reportProchaineTentative", () => {
  it("croît en doublant et se borne", () => {
    expect(reportProchaineTentative(1)).toBe(60_000);
    expect(reportProchaineTentative(2)).toBe(120_000);
    expect(reportProchaineTentative(3)).toBe(240_000);
    expect(reportProchaineTentative(50)).toBe(6 * 60 * 60 * 1000);
  });
});

describe("credentialsDepuisEnv", () => {
  it("rend null plutôt qu'un objet incomplet quand un secret manque", () => {
    expect(credentialsDepuisEnv({ GOOGLE_ADS_OAUTH_CLIENT_ID: "a" } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      credentialsDepuisEnv({
        GOOGLE_ADS_OAUTH_CLIENT_ID: "a",
        GOOGLE_ADS_OAUTH_CLIENT_SECRET: "b",
        GOOGLE_ADS_REFRESH_TOKEN: "c",
      } as NodeJS.ProcessEnv),
    ).toEqual({ clientId: "a", clientSecret: "b", refreshToken: "c" });
  });
});

/* ═════════════════════════════════ Drain ══════════════════════════════════ */

describe("drainerConversions — le chemin nominal", () => {
  it("envoie, marque, et joint l'instant en UTC strict", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const ingest = faussIngest();

    const bilan = await drainerConversions({
      base: db,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials,
      loginAccountId: "6437191896",
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });

    expect(bilan).toMatchObject({ reclamees: 1, envoyees: 1, ecartees: 0, echouees: 0 });
    expect(ingest.appels).toHaveLength(1);
    expect(ingest.appels[0].destination).toEqual({
      operatingAccountId: "2568911678",
      loginAccountId: "6437191896",
      conversionActionId: "987654321",
    });
    expect(ingest.appels[0].evenements[0]).toMatchObject({
      transactionId: "1:order_4711:987654321",
      gclid: "Cj0KCQjwReel",
      // 🔴 L'assertion qui rougirait sur un décalage d'une heure. Sous
      // `TZ=America/New_York`, un `new Date(colonne)` glissé n'importe où dans
      // la chaîne donnerait `14:00:00`.
      occurredAt: "2026-08-29T10:00:00.000Z",
      value: 42.9,
      currency: "EUR",
      consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" },
    });

    const l = await lire();
    expect(l.status).toBe(ETAT.envoye);
    expect(l.google_request_id).toBe("req-1");
    expect(l.last_error).toBeNull();
    expect(depuisColonne(l.sent_at).toISOString()).toBe(MAINTENANT.toISOString());
  });

  it("ne reprend pas une ligne déjà envoyée", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const deps = {
      base: db,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials,
      maintenant: () => MAINTENANT,
    };
    await drainerConversions({ ...deps, ingest: faussIngest().fn });

    const second = faussIngest();
    const bilan = await drainerConversions({ ...deps, ingest: second.fn });
    expect(bilan.reclamees).toBe(0);
    expect(second.appels).toHaveLength(0);
  });

  it("regroupe par destination : deux actions de conversion, deux envois", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    await enregistrerConversion(conversion({ conversionActionId: "111" }), db, MAINTENANT);
    const ingest = faussIngest();

    await drainerConversions({
      base: db,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials,
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });

    expect(ingest.appels).toHaveLength(2);
    expect(ingest.appels.map(a => (a.destination as any).conversionActionId).sort()).toEqual([
      "111",
      "987654321",
    ]);
  });
});

describe("drainerConversions — les règles bloquent AVANT le réseau", () => {
  it("écarte sans jamais appeler Google, et le dit dans last_error", async () => {
    await enregistrerConversion(conversion({ consentAdUserData: "CONSENT_DENIED" }), db, MAINTENANT);
    const ingest = faussIngest();

    const bilan = await drainerConversions({
      base: db,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials,
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });

    expect(ingest.fn).not.toHaveBeenCalled();
    expect(bilan).toMatchObject({ ecartees: 1, envoyees: 0 });
    const l = await lire();
    expect(l.status).toBe(ETAT.ecarte);
    expect(l.last_error).toContain(MOTIF.consentementRefuse);
  });

  it("un site sans réglages Ads est écarté, pas réessayé indéfiniment", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const ingest = faussIngest();

    await drainerConversions({
      base: db,
      chargerReglages: reglagesInjectes(null),
      credentials,
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });

    expect(ingest.fn).not.toHaveBeenCalled();
    expect((await lire()).status).toBe(ETAT.ecarte);
  });

  it("charge les réglages depuis ads_site_settings quand rien n'est injecté", async () => {
    // Contrôle du chemin réel : sans cette ligne en base, rien ne part.
    await client.exec(
      `INSERT INTO ads_site_settings (site_id, customer_id, enabled) VALUES (1, '2568911678', true)`,
    );
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const ingest = faussIngest();

    const bilan = await drainerConversions({
      base: db,
      credentials,
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });

    expect(bilan.envoyees).toBe(1);
    expect((ingest.appels[0].destination as any).operatingAccountId).toBe("2568911678");
  });
});

describe("drainerConversions — reprise sur erreur", () => {
  const deps = (ingest: any) => ({
    base: db,
    chargerReglages: reglagesInjectes(reglagesActifs),
    credentials,
    ingest,
    maintenant: () => MAINTENANT,
  });

  it("une erreur définitive n'est jamais réessayée", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    // 400/403/404 : une configuration fausse ne se répare pas en insistant.
    const ingest = faussIngest(new AdsIngestError("action inconnue", false, 404));

    const bilan = await drainerConversions(deps(ingest.fn));
    expect(bilan).toMatchObject({ echouees: 1, reportees: 0 });

    const l = await lire();
    expect(l.status).toBe(ETAT.echoue);
    expect(l.last_error).toContain("action inconnue");
    expect(l.last_error).not.toContain("retry_budget_exhausted");

    // Et le drain suivant ne la voit plus.
    const second = faussIngest();
    expect((await drainerConversions(deps(second.fn))).reclamees).toBe(0);
  });

  it("une erreur transitoire repart, avec une échéance repoussée et un essai consommé", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const ingest = faussIngest(new AdsIngestError("service indisponible", true, 503));

    const bilan = await drainerConversions(deps(ingest.fn));
    expect(bilan).toMatchObject({ reportees: 1, echouees: 0 });

    const l = await lire();
    expect(l.status).toBe(ETAT.enAttente);
    expect(l.attempts).toBe(1);
    expect(depuisColonne(l.next_attempt_at).toISOString()).toBe(
      new Date(MAINTENANT.getTime() + reportProchaineTentative(1)).toISOString(),
    );

    // Elle n'est pas due tout de suite, et redevient due après le report.
    expect((await drainerConversions(deps(faussIngest().fn))).reclamees).toBe(0);
    const plusTard = new Date(MAINTENANT.getTime() + reportProchaineTentative(1));
    const reprise = faussIngest();
    const b2 = await drainerConversions({ ...deps(reprise.fn), maintenant: () => plusTard });
    expect(b2.envoyees).toBe(1);
  });

  it("abandonne explicitement quand le budget d'essais est épuisé", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const erreur = new AdsIngestError("service indisponible", true, 503);

    let instant = MAINTENANT;
    for (let i = 0; i < MAX_TENTATIVES; i++) {
      const ingest = faussIngest(erreur);
      await drainerConversions({ ...deps(ingest.fn), maintenant: () => instant });
      instant = new Date(instant.getTime() + REPORT_LARGE);
    }

    const l = await lire();
    expect(l.attempts).toBe(MAX_TENTATIVES);
    expect(l.status).toBe(ETAT.echoue);
    // L'abandon est VISIBLE : sans ce code, une file qui se vide en silence
    // ressemble à une file qui s'est vidée normalement.
    expect(l.last_error).toContain("retry_budget_exhausted");
  });

  it("traite une erreur non classée comme transitoire plutôt que de perdre la conversion", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const ingest = faussIngest(new Error("TypeError inattendue"));
    const bilan = await drainerConversions(deps(ingest.fn));
    expect(bilan).toMatchObject({ reportees: 1, echouees: 0 });
  });

  it("reporte sans consommer d'essai quand les identifiants serveur manquent", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    const ingest = faussIngest();

    const bilan = await drainerConversions({
      base: db,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials: undefined,
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });

    expect(ingest.fn).not.toHaveBeenCalled();
    expect(bilan.reportees).toBe(1);
    expect((await lire()).status).toBe(ETAT.enAttente);
  });
});

/** Report assez large pour que la ligne soit à nouveau due au tour suivant. */
const REPORT_LARGE = 12 * 60 * 60 * 1000;

/* ══════════════════════════════ Concurrence ═══════════════════════════════ */

describe("concurrence — deux drains ne doublent pas les envois", () => {
  it("le bail rend la ligne invisible au second drain", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);
    await enregistrerConversion(conversion({ businessEventId: "order_4712" }), db, MAINTENANT);

    const a = faussIngest();
    const b = faussIngest();
    const commun = {
      base: db,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials,
      maintenant: () => MAINTENANT,
    };

    // Les deux passages partent ensemble, comme le feraient deux workers.
    const [bilanA, bilanB] = await Promise.all([
      drainerConversions({ ...commun, ingest: a.fn }),
      drainerConversions({ ...commun, ingest: b.fn }),
    ]);

    // Chaque conversion n'est envoyée qu'UNE fois, tous drains confondus.
    const envoyes = [...a.appels, ...b.appels].flatMap(ap => ap.evenements.map((e: any) => e.transactionId));
    expect(envoyes.sort()).toEqual(["1:order_4711:987654321", "1:order_4712:987654321"]);
    expect(bilanA.reclamees + bilanB.reclamees).toBe(2);

    const lignes = await toutes();
    expect(lignes.every((l: any) => l.status === ETAT.envoye)).toBe(true);
  });

  it("une ligne réclamée est retirée de la file pour la durée du bail", async () => {
    await enregistrerConversion(conversion(), db, MAINTENANT);

    const premier = await reclamerLot(db, MAINTENANT);
    expect(premier).toHaveLength(1);
    expect(premier[0].attempts).toBe(1);

    // Un second drain, à la même seconde : rien.
    expect(await reclamerLot(db, MAINTENANT)).toHaveLength(0);

    // Le bail protège aussi contre la mort du processus : la ligne revient
    // d'elle-même à son expiration, et un envoi déjà parti ne sera pas compté
    // deux fois puisque le transactionId est la clé d'idempotence.
    const apresBail = new Date(MAINTENANT.getTime() + BAIL_MS + 1000);
    expect(await reclamerLot(db, apresBail)).toHaveLength(1);
  });

  it("consomme un essai même quand le processus meurt en plein envoi", async () => {
    // Sans cet incrément à la réclamation, une boucle de plantage réessaierait
    // indéfiniment sans jamais atteindre le budget, et la file ne se viderait
    // jamais.
    await enregistrerConversion(conversion(), db, MAINTENANT);
    await reclamerLot(db, MAINTENANT);
    expect((await lire()).attempts).toBe(1);
  });
});

/**
 * La frontière entre le SQL et le TypeScript : ce que `versLigne` fait d'une
 * ligne brute, et ce que `lignesDe` fait des deux formes de résultat que les
 * pilotes rendent. Aucun de ces défauts ne lève quoi que ce soit en production —
 * ils fabriquent des `NaN` et des tableaux vides qui traversent le drain sans
 * bruit.
 */
describe("lecture d'une ligne brute", () => {
  /** Ce que rendrait le `RETURNING` de `reclamerLot`, colonnes en snake_case. */
  const brute = () => ({
    id: "12",
    site_id: "1",
    business_event_id: "order_4711",
    conversion_action_id: "987654321",
    click_id_type: "gclid",
    click_id: "Cj0KCQjwReel",
    occurred_at: "2026-08-29 10:00:00",
    click_at: "2026-08-26 12:00:00",
    value: "42.90",
    currency: "EUR",
    consent_ad_user_data: "CONSENT_GRANTED",
    consent_ad_personalization: "CONSENT_GRANTED",
    attempts: "1",
  });

  it("convertit les chaînes rendues par le pilote en nombres et en dates UTC", () => {
    const l = versLigne(brute());
    expect(l).toMatchObject({ id: 12, siteId: 1, value: 42.9, attempts: 1, currency: "EUR" });
    expect(l.occurredAt.toISOString()).toBe("2026-08-29T10:00:00.000Z");
    expect(l.clickAt.toISOString()).toBe("2026-08-26T12:00:00.000Z");
  });

  it("🔴 une conversion sans valeur monétaire donne null, jamais NaN", () => {
    // La colonne `value` est nullable et l'est POUR DE VRAI : une prise de
    // contact n'a pas de montant. `Number(null)` vaut 0 — un montant nul envoyé
    // à Google est accepté, compté, et fausse le ROAS sur lequel les enchères
    // se règlent. `NaN`, lui, part en JSON comme `null` et rend le message
    // invalide. Les deux sont muets.
    expect(versLigne({ ...brute(), value: null }).value).toBeNull();
    expect(versLigne({ ...brute(), value: undefined }).value).toBeNull();
    expect(versLigne({ ...brute(), value: "pas-un-montant" }).value).toBeNull();
  });

  it("accepte un montant déjà rendu comme nombre par le pilote", () => {
    // postgres-js et PGlite ne s'accordent pas sur le type des colonnes
    // `numeric` : l'un rend une chaîne, l'autre peut rendre un nombre. Les deux
    // doivent donner le même montant, sans quoi le drain envoie à Google une
    // valeur différente selon le pilote installé.
    expect(versLigne({ ...brute(), value: 42.9 }).value).toBe(42.9);
    expect(versLigne({ ...brute(), value: "42.90" }).value).toBe(42.9);
  });

  it("🔴 un compteur d'essais absent vaut 0, jamais NaN", () => {
    // La cascade complète si `attempts` devenait NaN : la comparaison au budget
    // d'essais est fausse, donc la ligne n'est jamais abandonnée ; le report
    // exponentiel rend NaN, donc `next_attempt_at` devient une date invalide,
    // que Postgres refuse. La conversion reste alors bloquée pour toujours dans
    // un état que rien ne signale.
    expect(versLigne({ ...brute(), attempts: undefined }).attempts).toBe(0);
    expect(versLigne({ ...brute(), attempts: null }).attempts).toBe(0);
  });

  it("une devise absente retombe sur EUR plutôt que sur la chaîne « null »", () => {
    // Sans le repli, `String(null)` donne littéralement "null", que Google
    // refuse en 400 : la conversion échoue au lieu de partir en euros.
    expect(versLigne({ ...brute(), currency: null }).currency).toBe("EUR");
    expect(versLigne({ ...brute(), currency: undefined }).currency).toBe("EUR");
  });

  it("rend un horodatage déjà construit tel quel, sans le retraverser", () => {
    const instant = new Date("2026-08-29T10:00:00.000Z");
    expect(depuisColonne(instant)).toBe(instant);
  });

  it("🔴 refuse bruyamment un horodatage illisible au lieu de propager une date invalide", () => {
    // Sans ce refus, `new Date("...")` rend `Invalid Date`, dont le
    // `toISOString()` lève PLUS TARD — dans le drain, au moment de fabriquer le
    // message, avec une pile qui accuse le client réseau. Le refus ici nomme la
    // vraie cause et la valeur fautive.
    expect(() => depuisColonne("29/08/2026 10:00")).toThrow(TypeError);
    expect(() => depuisColonne("")).toThrow(/illisible/);
  });
});

describe("les deux formes de résultat que les pilotes rendent", () => {
  /**
   * 🔴 Le piège documenté en tête de `outbox.ts`, mis à l'épreuve : postgres-js
   * rend directement le tableau de lignes, PGlite rend `{ rows: [...] }`. Un
   * module écrit contre un seul des deux lirait des tableaux vides contre
   * l'autre — c'est-à-dire « aucune valeur par défaut trouvée », donc des
   * conversions envoyées à zéro euro. Vert en test, faux en production, et
   * dans le sens le plus coûteux : Google accepte et compte.
   */
  const baseRendant = (resultat: unknown): BaseOutbox => ({ execute: async () => resultat });
  const correspondance = [{ default_value: "42.90", currency: "USD" }];

  it.each([
    ["postgres-js (tableau nu)", correspondance],
    ["PGlite ({ rows })", { rows: correspondance }],
  ])("lit une valeur par défaut à l'identique sous %s", async (_pilote, resultat) => {
    expect(await resoudreValeurParDefaut(baseRendant(resultat), 1, { eventName: "order_paid", conversionActionId: "1" }))
      .toEqual({ value: 42.9, currency: "USD" });
  });

  it.each([
    ["résultat sans lignes", { rows: [] }],
    ["forme inattendue d'un futur pilote", { rowCount: 1 }],
    ["résultat nul", null],
  ])("ne devine aucune valeur par défaut sur %s", async (_cas, resultat) => {
    // Ne rien trouver doit donner « pas de défaut », pas une exception : le
    // repli est facultatif par conception.
    expect(await resoudreValeurParDefaut(baseRendant(resultat), 1, { conversionActionId: "1" })).toEqual({
      value: null,
      currency: null,
    });
  });

  it("ne devine rien quand DEUX correspondances visent la même action", async () => {
    // Deux événements peuvent viser la même action de conversion avec des
    // montants différents : choisir fabriquerait un montant faux et plausible,
    // ce qui est pire que zéro parce que zéro se voit.
    const deux = [{ default_value: "10.00", currency: "EUR" }, { default_value: "99.00", currency: "EUR" }];
    expect(await resoudreValeurParDefaut(baseRendant(deux), 1, { conversionActionId: "1" })).toEqual({
      value: null,
      currency: null,
    });
  });

  it("rend une devise nulle quand la correspondance n'en porte pas", async () => {
    // Le schéma actuel a un DEFAULT 'EUR' NOT NULL sur cette colonne, donc ce
    // cas ne vient pas de la base : il vient de `BaseOutbox`, qui est un point
    // d'injection. Ce que le test fige, c'est que l'absence redescend en `null`
    // et laisse le repli suivant décider, au lieu d'écrire "null" en devise.
    expect(
      await resoudreValeurParDefaut(baseRendant([{ default_value: "5.00", currency: null }]), 1, {
        conversionActionId: "1",
      }),
    ).toEqual({ value: 5, currency: null });
  });
});

describe("enregistrement sans montant ni devise", () => {
  beforeEach(async () => {
    await (client as any).exec(`INSERT INTO "sites" ("site_id","name") VALUES (1,'asd') ON CONFLICT DO NOTHING`);
  });

  it("écrit EUR et une valeur nulle quand aucune correspondance ne peut trancher", async () => {
    // `value` absent déclenche la recherche d'un défaut ; aucune correspondance
    // n'existe, donc la conversion part sans montant. C'est légitime (un
    // formulaire de contact) et ça ne doit ni bloquer, ni écrire 0 : un zéro
    // serait compté par Google et abaisserait le ROAS du client.
    const { value, currency, ...reste } = conversion();
    await enregistrerConversion({ ...reste }, db, MAINTENANT);

    const l = await lire();
    expect(l.value).toBeNull();
    expect(l.currency).toBe("EUR");
  });

  it("retient la devise de la correspondance quand l'appelant n'en donne pas", async () => {
    await (client as any).exec(
      `INSERT INTO ads_conversion_mappings (site_id, event_name, conversion_action_id, default_value, currency)
       VALUES (1, 'order_paid', '987654321', 19.99, 'CHF')`,
    );
    const { value, currency, ...reste } = conversion();
    await enregistrerConversion({ ...reste, eventName: "order_paid" }, db, MAINTENANT);

    const l = await lire();
    expect(Number(l.value)).toBe(19.99);
    expect(l.currency).toBe("CHF");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Le lot empoisonné : une ligne indigeste ne doit pas emporter ses voisines.
 *
 * `buildIngestPayload` construit tout le message d'un coup. Une seule ligne dont
 * l'identifiant de clic est vide y fait lever `pickAdIdentifiers`, AVANT le
 * moindre appel réseau, en `retryable: false` — et le lot entier partait en
 * échec définitif. Jusqu'à 199 conversions valides perdues sans rattrapage
 * possible, pour la faute d'une voisine.
 *
 * Deux barrages sont posés, et les deux comptent : le refus à l'écriture (là où
 * l'appelant peut corriger) et l'écartement individuel au drain (pour tout ce
 * qui serait déjà en base).
 * ──────────────────────────────────────────────────────────────────────────── */

describe("refus à l'écriture d'une conversion qui ne peut produire aucun message", () => {
  it("un identifiant de clic vide est refusé, et rien n'est écrit", async () => {
    // La chaîne vide satisfait `NOT NULL` : c'est précisément ce qui la rendait
    // capable de traverser tout le module jusqu'à l'envoi.
    await expect(enregistrerConversion(conversion({ clickId: "" }), db, MAINTENANT)).rejects.toThrow(
      /sans identifiant de clic/,
    );
    expect(await toutes()).toHaveLength(0);
  });

  it("un identifiant de clic fait d'espaces est refusé lui aussi", async () => {
    await expect(enregistrerConversion(conversion({ clickId: "   " }), db, MAINTENANT)).rejects.toThrow(
      /sans identifiant de clic/,
    );
    expect(await toutes()).toHaveLength(0);
  });

  it("un horodatage illisible est refusé en nommant le champ fautif", async () => {
    await expect(
      enregistrerConversion(conversion({ occurredAt: "pas une date" }), db, MAINTENANT),
    ).rejects.toThrow(/occurredAt/);
    await expect(enregistrerConversion(conversion({ clickAt: "hier" }), db, MAINTENANT)).rejects.toThrow(
      /clickAt/,
    );
    expect(await toutes()).toHaveLength(0);
  });

  it("le CHECK de la base refuse un identifiant vide inséré sans passer par le module", async () => {
    // Le filet, pour tout ce qui n'emprunterait pas `enregistrerConversion`.
    await expect(
      client.query(
        `INSERT INTO ads_conversion_outbox
           (site_id, business_event_id, conversion_action_id, click_id_type, click_id,
            click_at, occurred_at, consent_ad_user_data, consent_ad_personalization)
         VALUES (1, 'x', '987654321', 'gclid', '',
            '2026-08-26 12:00:00', '2026-08-29 10:00:00', 'CONSENT_GRANTED', 'CONSENT_GRANTED')`,
      ),
    ).rejects.toThrow(/ads_conversion_outbox_click_id_check/);
  });

  it("une conversion normale passe toujours — le contrôle ne mord que les cassées", async () => {
    const r = await enregistrerConversion(conversion(), db, MAINTENANT);
    expect(r.cree).toBe(true);
  });
});

describe("drain — une ligne indigeste est écartée SEULE", () => {
  /**
   * Base injectée qui rend des lignes brutes à la réclamation puis avale les
   * marquages. On passe par là plutôt que par PGlite pour une raison de fond :
   * le `CHECK` empêche désormais d'ÉCRIRE une ligne vide, donc le seul moyen de
   * prouver l'isolement du drain est de lui en présenter une comme le ferait une
   * base peuplée avant que la contrainte n'existe.
   */
  function baseAvec(lignes: Record<string, unknown>[]) {
    const marquages: string[] = [];
    let premiere = true;
    const execute = vi.fn(async (requete: any) => {
      if (premiere) {
        premiere = false;
        return { rows: lignes };
      }
      marquages.push(String(requete?.queryChunks ? "update" : "update"));
      return { rows: [] };
    });
    return { base: { execute }, execute, marquages };
  }

  const brute = (sur: Record<string, unknown> = {}) => ({
    id: 1,
    site_id: 1,
    business_event_id: "order_4711",
    conversion_action_id: "987654321",
    click_id_type: "gclid",
    click_id: "Cj0KCQjwReel",
    occurred_at: "2026-08-29 10:00:00",
    click_at: "2026-08-26 12:00:00",
    value: "42.90",
    currency: "EUR",
    consent_ad_user_data: "CONSENT_GRANTED",
    consent_ad_personalization: "CONSENT_GRANTED",
    attempts: "1",
    ...sur,
  });

  it("deux lignes saines partent malgré une troisième sans identifiant de clic", async () => {
    const { base } = baseAvec([
      brute({ id: 1, business_event_id: "ok_a" }),
      brute({ id: 2, business_event_id: "cassee", click_id: "" }),
      brute({ id: 3, business_event_id: "ok_b" }),
    ]);
    const ingest = faussIngest();

    const bilan = await drainerConversions({
      base: base as any,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials,
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });

    // Le cœur du test : 2 envoyées, 1 échouée. Avant la correction, c'était 0 et 3.
    expect(bilan.envoyees, "les voisines saines doivent partir").toBe(2);
    expect(bilan.echouees).toBe(1);

    // Et le réseau a bien été appelé, avec les deux bonnes lignes seulement.
    expect(ingest.appels).toHaveLength(1);
    expect(ingest.appels[0].evenements.map((e: any) => e.transactionId)).toEqual([
      "1:ok_a:987654321",
      "1:ok_b:987654321",
    ]);
  });

  it("la ligne écartée porte le motif « message impossible », en échec définitif", async () => {
    const { base, execute } = baseAvec([brute({ id: 7, click_id: "" })]);
    const ingest = faussIngest();

    await drainerConversions({
      base: base as any,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials,
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });

    // `failed` et non `skipped` : rien n'a été décidé, la ligne est cassée.
    const marquage = JSON.stringify(execute.mock.calls[1]?.[0]);
    expect(marquage).toContain(ETAT.echoue);
    expect(marquage).toContain(MOTIF.messageImpossible);
    expect(marquage, "un motif inventé ailleurs signalerait une divergence").toContain(
      "unbuildable_event",
    );
  });

  it("un groupe entièrement indigeste ne joint jamais Google", async () => {
    // Sans ce contrôle, un lot vide partirait quand même : `ingestConversions`
    // rend un succès sur zéro événement, et les lignes seraient marquées
    // « envoyées » alors que rien n'est parti.
    const { base } = baseAvec([brute({ id: 1, click_id: "" }), brute({ id: 2, click_id: "" })]);
    const ingest = faussIngest();

    const bilan = await drainerConversions({
      base: base as any,
      chargerReglages: reglagesInjectes(reglagesActifs),
      credentials,
      ingest: ingest.fn,
      maintenant: () => MAINTENANT,
    });

    expect(ingest.fn).not.toHaveBeenCalled();
    expect(bilan.echouees).toBe(2);
    expect(bilan.envoyees).toBe(0);
  });
});
