/**
 * Ce que ce fichier protège.
 *
 * Le balayage est la seule pièce du module qui DÉCLENCHE quelque chose. Toutes
 * les autres sont des mécanismes qu'on appelle ; celle-ci décide, seule, toutes
 * les cinq minutes, sans personne pour regarder. Ses défauts sont donc muets par
 * construction : un balayage qui n'inscrit rien produit exactement le même écran
 * qu'un site sans trafic payant, et un balayage qui inscrit deux fois produit
 * deux conversions chez Google, sans erreur nulle part.
 *
 * D'où les mêmes partis pris que `outbox.test.ts` :
 *
 *  - **PGlite plutôt qu'une base simulée**, avec le DDL de la migration 0016.
 *    L'idempotence est une CONTRAINTE de base ; la simuler reviendrait à tester
 *    qu'on sait écrire un `Set` ;
 *  - **`enregistrerConversion` n'est PAS remplacé.** C'est précisément le lien
 *    qui manquait au module : le simuler prouverait que le balayage sait appeler
 *    une fonction, pas que la chaîne existe ;
 *  - **un fuseau décalé** (`America/New_York`), pour la même raison qu'ailleurs :
 *    un `new Date("2026-08-29 10:00:00")` réintroduit quelque part rendrait
 *    quatre heures d'écart, invisible sous le `TZ=UTC` d'une CI.
 *
 * ClickHouse, lui, est simulé — c'est une lecture, et le point à démontrer est ce
 * qu'on FAIT des lignes, pas que ClickHouse sait trier.
 */
process.env.TZ = "America/New_York";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

const pgliteTest = vi.hoisted(() => ({ client: null as any }));

/** Le drain lit les réglages par `lireReglages` (lot E) : on la rebranche sur la PGlite. */
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
  CLES_VALEUR,
  balayerConversions,
  balayerSite,
  construireRequeteEvenements,
  construireRequeteNonMappes,
  identifiantEvenementMetier,
  lireConsentement,
  lireProps,
  lireValeur,
  serialiserStable,
  type BilanBalayage,
  type EvenementMetier,
} from "./balayage.js";
import { drainerConversions, type BaseOutbox } from "./outbox.js";
import type { IngestResult } from "./dataManager.js";
import type { ResultatAttribution } from "./attribution.js";

const client = new PGlite();
pgliteTest.client = client;
const db = drizzle(client) as unknown as BaseOutbox;

/** DDL de la migration 0016, recopié — cf. `outbox.test.ts`. */
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
  CONSTRAINT "ads_conversion_outbox_click_id_type_check" CHECK ("click_id_type" IN ('gclid', 'gbraid', 'wbraid'))
);

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
  "event_name" text NOT NULL,
  "conversion_action_id" text NOT NULL,
  "default_value" numeric(14, 2),
  "currency" text DEFAULT 'EUR' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ads_conversion_mappings_site_event_unique" UNIQUE("site_id","event_name")
);
`;

const MAINTENANT = new Date("2026-08-29T12:00:00.000Z");
const CLIC = "2026-08-27T09:00:00Z";

/**
 * Le schéma est créé UNE fois ; chaque test se contente de vider les tables.
 *
 * Rejouer le DDL à chaque test faisait dépasser les dix secondes du hook sur une
 * machine chargée — un échec qui n'apprend rien sur le code et qui rend la suite
 * capricieuse selon l'heure à laquelle on la lance.
 */
async function reinitialiser() {
  await client.exec(
    `TRUNCATE "ads_conversion_outbox", "ads_conversion_mappings", "ads_scan_state", "ads_site_settings", "sites" RESTART IDENTITY CASCADE;`,
  );
}

async function creerSite(siteId: number, options: { enabled?: boolean; testMode?: boolean } = {}) {
  await client.query(`INSERT INTO sites (site_id, name) VALUES ($1, $2)`, [siteId, `site-${siteId}`]);
  await client.query(
    `INSERT INTO ads_site_settings (site_id, customer_id, enabled, test_mode) VALUES ($1, '2568911678', $2, $3)`,
    [siteId, options.enabled ?? true, options.testMode ?? false],
  );
}

async function creerCorrespondance(
  siteId: number,
  eventName: string,
  conversionActionId = "987654321",
  defaultValue: string | null = null,
  currency = "EUR",
) {
  await client.query(
    `INSERT INTO ads_conversion_mappings (site_id, event_name, conversion_action_id, default_value, currency)
     VALUES ($1, $2, $3, $4, $5)`,
    [siteId, eventName, conversionActionId, defaultValue, currency],
  );
}

async function journal(siteId = 1) {
  const r = await client.query(
    `SELECT business_event_id, conversion_action_id, click_id, click_id_type, value, currency,
            consent_ad_user_data, status, occurred_at
       FROM ads_conversion_outbox WHERE site_id = $1 ORDER BY id`,
    [siteId],
  );
  return r.rows as any[];
}

/** Le bilan persisté du dernier passage, tel que l'écran de santé le lira. */
async function bilanPersiste(siteId = 1) {
  const r = await client.query(`SELECT * FROM ads_scan_state WHERE site_id = $1`, [siteId]);
  return (r.rows[0] ?? null) as any;
}

function evenement(sur: Partial<EvenementMetier> = {}): EvenementMetier {
  return {
    eventName: "order_confirmed",
    horodatage: "2026-08-29T10:00:00Z",
    sessionId: "sess-1",
    utilisateur: "user-42",
    props: JSON.stringify({ total_eur: 42.9, ads_consent_ad_user_data: "granted" }),
    ...sur,
  };
}

/** Faux lot ClickHouse. Une file par appel : un site, un lot. */
function faussesLectures(lots: EvenementMetier[][] | Error) {
  const specs: any[] = [];
  const fn = async (spec: any) => {
    specs.push(spec);
    if (lots instanceof Error) throw lots;
    return lots.shift() ?? [];
  };
  return { fn, specs };
}

/** Fausse attribution : rend toujours le même clic, sauf ordre contraire. */
function fausseAttribution(identifiant: ResultatAttribution["identifiant"] | Error = {
  type: "gclid",
  valeur: "Cj0KCQjwReel",
  horodatage: CLIC,
}) {
  const appels: any[] = [];
  const fn = async (demande: any): Promise<ResultatAttribution> => {
    appels.push(demande);
    if (identifiant instanceof Error) throw identifiant;
    return { identifiant, utilisateur: demande.utilisateur, appareils: [demande.utilisateur], clics: [] };
  };
  return { fn: fn as any, appels };
}

function deps(lots: EvenementMetier[][] | Error, attribution = fausseAttribution()) {
  const lectures = faussesLectures(lots);
  return {
    outils: {
      base: db,
      lireEvenements: lectures.fn as any,
      compterNonMappes: (async () => []) as any,
      attribuer: attribution.fn,
      maintenant: () => MAINTENANT,
    },
    lectures,
    attribution,
  };
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
await client.exec(DDL);

beforeEach(async () => {
  await reinitialiser();
});

/* ─────────────────────────── Fonctions pures ────────────────────────────── */

describe("identifiantEvenementMetier", () => {
  it("privilégie l'identifiant de commande porté par props", () => {
    const id = identifiantEvenementMetier(evenement({ props: JSON.stringify({ order_id: "CMD-4711" }) }));
    expect(id).toBe("cmd:order_confirmed:CMD-4711");
  });

  it("🔴 la session de paiement l'emporte sur l'identifiant ERP quand les deux sont là", () => {
    // ASD envoie les deux. `order_id` n'existe QUE si la commande a été
    // matérialisée ; `checkout_session_id` existe toujours. Préférer l'ERP
    // donnerait une clé à l'événement émis avant matérialisation et une AUTRE au
    // même achat vu ensuite : une commande comptée deux fois par Google.
    const avecLesDeux = evenement({
      props: JSON.stringify({ order_id: "CMD-4711", checkout_session_id: "cs_test_a1b2" }),
    });
    expect(identifiantEvenementMetier(avecLesDeux)).toBe("cmd:order_confirmed:cs_test_a1b2");
  });

  it("la clé ne CHANGE PAS quand l'identifiant ERP apparaît après coup", () => {
    // Le même achat, vu deux fois : d'abord sans son `order_id` (commande pas
    // encore matérialisée), puis avec. Une seule et même clé.
    const avant = evenement({ props: JSON.stringify({ checkout_session_id: "cs_test_a1b2" }) });
    const apres = evenement({
      props: JSON.stringify({ checkout_session_id: "cs_test_a1b2", order_id: "CMD-4711" }),
    });
    expect(identifiantEvenementMetier(avant)).toBe(identifiantEvenementMetier(apres));
  });

  it("retombe sur l'identifiant ERP quand il n'y a pas de session de paiement", () => {
    const id = identifiantEvenementMetier(evenement({ props: JSON.stringify({ order_id: "CMD-4711" }) }));
    expect(id).toBe("cmd:order_confirmed:CMD-4711");
  });

  it("est déterministe : deux lectures de la même ligne donnent la même clé", () => {
    const e = evenement();
    expect(identifiantEvenementMetier(e)).toBe(identifiantEvenementMetier({ ...e }));
  });

  it("ne dépend PAS de l'ordre des clés de props", () => {
    // 🔴 Le défaut le plus coûteux possible : une clé qui change entre deux
    // passages renvoie la conversion sous un nouveau transactionId, donc Google
    // la compte deux fois, sans la moindre erreur.
    const a = identifiantEvenementMetier(evenement({ props: '{"a":1,"b":2}' }));
    const b = identifiantEvenementMetier(evenement({ props: '{"b":2,"a":1}' }));
    expect(a).toBe(b);
  });

  it("distingue deux achats du même client à des instants différents", () => {
    const a = identifiantEvenementMetier(evenement({ horodatage: "2026-08-29T10:00:00Z" }));
    const b = identifiantEvenementMetier(evenement({ horodatage: "2026-08-29T10:00:05Z" }));
    expect(a).not.toBe(b);
  });

  it("distingue deux achats de montants différents dans la même seconde", () => {
    const a = identifiantEvenementMetier(evenement({ props: JSON.stringify({ total_eur: 10 }) }));
    const b = identifiantEvenementMetier(evenement({ props: JSON.stringify({ total_eur: 20 }) }));
    expect(a).not.toBe(b);
  });

  it("distingue deux sessions", () => {
    const a = identifiantEvenementMetier(evenement({ sessionId: "s1" }));
    const b = identifiantEvenementMetier(evenement({ sessionId: "s2" }));
    expect(a).not.toBe(b);
  });

  it("🔴 ne change PAS quand l'identité de l'utilisateur est renseignée après coup", () => {
    // `identifyService` réécrit rétroactivement `identified_user_id` sur les
    // événements anonymes des trente derniers jours. Dans la fenêtre de
    // rattrapage c'est le scénario ordinaire : on achète, on crée son compte une
    // heure plus tard. Si l'identité entrait dans la clé, le passage suivant
    // verrait un événement « neuf » et Google compterait la commande DEUX FOIS,
    // sous deux transactionId, sans la moindre erreur nulle part.
    const anonyme = evenement({ utilisateur: "empreinte-abc" });
    const identifie = evenement({ utilisateur: "user-42" });
    expect(identifiantEvenementMetier(anonyme)).toBe(identifiantEvenementMetier(identifie));
  });

  it("survit à un props illisible sans lever", () => {
    expect(() => identifiantEvenementMetier(evenement({ props: "{pas du json" }))).not.toThrow();
  });
});

describe("serialiserStable", () => {
  it("trie les clés à toute profondeur", () => {
    expect(serialiserStable({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it("conserve l'ordre des tableaux, qui porte du sens", () => {
    expect(serialiserStable([2, 1])).toBe("[2,1]");
  });
});

describe("lireConsentement", () => {
  it("n'accorde le consentement que sur un accord explicite", () => {
    expect(lireConsentement({ ads_consent_ad_user_data: "granted" }).adUserData).toBe("CONSENT_GRANTED");
    expect(lireConsentement({ consent_ad_user_data: true }).adUserData).toBe("CONSENT_GRANTED");
    expect(lireConsentement({ ad_user_data: "CONSENT_GRANTED" }).adUserData).toBe("CONSENT_GRANTED");
  });

  it("refuse tout le reste, y compris l'absence", () => {
    expect(lireConsentement({}).adUserData).toBe("CONSENT_UNSPECIFIED");
    expect(lireConsentement({ ads_consent_ad_user_data: "denied" }).adUserData).toBe("CONSENT_DENIED");
    expect(lireConsentement({ ads_consent_ad_user_data: "peut-être" }).adUserData).toBe("CONSENT_UNSPECIFIED");
  });

  it("fait suivre la personnalisation à l'usage des données quand elle est absente", () => {
    expect(lireConsentement({ ads_consent_ad_user_data: "granted" }).adPersonalization).toBe("CONSENT_GRANTED");
    expect(
      lireConsentement({ ads_consent_ad_user_data: "granted", ads_consent_ad_personalization: "denied" })
        .adPersonalization,
    ).toBe("CONSENT_DENIED");
  });
});

describe("lireValeur", () => {
  it("lit les clés déclarées et rien d'autre", () => {
    expect(lireValeur({ value: 12 })).toEqual({ value: 12 });
    expect(lireValeur({ total_eur: 42.9 })).toEqual({ value: 42.9, currency: "EUR" });
    // 🔴 Une clé qui n'est pas dans la liste ne devient JAMAIS un montant : un
    // chiffre faux et plausible est pire que zéro, parce que zéro se voit.
    expect(lireValeur({ panier_total: 99, items: 3 })).toEqual({});
  });

  it("rend `undefined` et jamais `null` : c'est ce qui déclenche le repli", () => {
    expect(lireValeur({}).value).toBeUndefined();
  });

  it("refuse un montant négatif ou illisible", () => {
    expect(lireValeur({ value: -1 })).toEqual({});
    expect(lireValeur({ value: "beaucoup" })).toEqual({});
  });

  it("n'accepte la devise de props que pour les clés sans devise implicite", () => {
    expect(lireValeur({ value: 10, currency: "usd" })).toEqual({ value: 10, currency: "USD" });
    expect(lireValeur({ total_eur: 10, currency: "usd" })).toEqual({ value: 10, currency: "EUR" });
  });

  it("liste fermée : toute clé acceptée est déclarée", () => {
    expect(CLES_VALEUR.every(([cle]) => typeof cle === "string" && cle.length > 0)).toBe(true);
  });
});

describe("lireProps", () => {
  it("ne lève jamais", () => {
    expect(lireProps("{cassé")).toEqual({});
    expect(lireProps("[1,2]")).toEqual({});
    expect(lireProps(null)).toEqual({});
    expect(lireProps({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("construireRequeteEvenements", () => {
  it("passe toutes les valeurs en paramètres liés, aucune concaténation", () => {
    const spec = construireRequeteEvenements({
      siteId: 1,
      noms: ["order_confirmed", "'; DROP TABLE events; --"],
      debut: new Date("2026-08-27T12:00:00Z"),
      fin: MAINTENANT,
    });
    expect(spec.query).not.toContain("DROP TABLE");
    expect(spec.query).not.toContain("order_confirmed");
    expect(spec.params?.noms).toEqual(["order_confirmed", "'; DROP TABLE events; --"]);
    expect(spec.params?.siteId).toBe(1);
  });

  it("ancre les bornes ET la projection sur UTC", () => {
    const spec = construireRequeteEvenements({ siteId: 1, noms: ["x"], debut: MAINTENANT, fin: MAINTENANT });
    expect(spec.query).toContain("toDateTime({debut:String}, 'UTC')");
    expect(spec.query).toContain("toDateTime({fin:String}, 'UTC')");
    // %FT%TZ et pas %Y-%m-%dT%H:%M:%SZ, où %M est le MOIS en toutes lettres.
    expect(spec.query).toContain("formatDateTime(timestamp, '%FT%TZ', 'UTC')");
    expect(spec.query).not.toContain("%H:%M:%S");
  });

  it("normalise les bornes pour ClickHouse (ni Z ni décalage)", () => {
    const spec = construireRequeteEvenements({ siteId: 1, noms: ["x"], debut: MAINTENANT, fin: MAINTENANT });
    expect(spec.params?.debut).toBe("2026-08-29 12:00:00");
    expect(String(spec.params?.debut)).not.toMatch(/[Z+]/);
  });

  it("trie du plus ancien au plus récent : la troncature perd le rattrapable, pas l'inverse", () => {
    const spec = construireRequeteEvenements({ siteId: 1, noms: ["x"], debut: MAINTENANT, fin: MAINTENANT });
    expect(spec.query).toContain("ORDER BY timestamp ASC");
  });
});

/* ──────────────────────────── Le balayage ───────────────────────────────── */

describe("balayerConversions", () => {
  it("un événement mappé produit une ligne de journal", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const d = deps([[evenement()]]);

    const bilan = await balayerConversions(d.outils);

    expect(bilan.inscrits).toBe(1);
    const lignes = await journal();
    expect(lignes).toHaveLength(1);
    expect(lignes[0].conversion_action_id).toBe("987654321");
    expect(lignes[0].click_id).toBe("Cj0KCQjwReel");
    expect(lignes[0].click_id_type).toBe("gclid");
    expect(Number(lignes[0].value)).toBe(42.9);
    expect(lignes[0].consent_ad_user_data).toBe("CONSENT_GRANTED");
    expect(lignes[0].status).toBe("pending");
  });

  it("rejouer le balayage sur la même période ne crée RIEN de nouveau", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const e = evenement();

    await balayerConversions(deps([[e]]).outils);
    const second = await balayerConversions(deps([[e]]).outils);

    expect(second.inscrits).toBe(0);
    expect(second.dejaConnus).toBe(1);
    expect(await journal()).toHaveLength(1);
  });

  it("le rejeu tient MÊME si le pré-contrôle ne voit rien : la base est le vrai garde", async () => {
    // 🔴 Le pré-contrôle (« déjà au journal ») est une optimisation. S'il tombe,
    // l'idempotence doit tenir quand même — sinon la protection repose sur une
    // requête de confort, et personne ne s'en apercevrait.
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const e = evenement();

    await balayerConversions(deps([[e]]).outils);
    // On antidate la ligne écrite : le pré-contrôle, borné par `occurred_at`,
    // ne la voit plus. Seule la contrainte d'unicité peut encore protéger.
    await client.query(`UPDATE ads_conversion_outbox SET occurred_at = '2020-01-01T00:00:00Z'::timestamp`);
    const second = await balayerConversions(deps([[e]]).outils);

    expect(second.inscrits).toBe(0);
    expect(second.dejaConnus).toBe(1);
    expect(await journal()).toHaveLength(1);
  });

  it("une conversion déjà au journal ne relance AUCUNE attribution", async () => {
    // Le pré-contrôle est une optimisation, pas une protection : le sabotage qui
    // le retire laisse toute la suite verte, puisque la contrainte d'unicité fait
    // le travail. Sa disparition serait donc silencieuse — et coûteuse : une
    // requête ClickHouse par événement déjà traité, à chaque passage, pour rien.
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const e = evenement();

    await balayerConversions(deps([[e]]).outils);

    const attribution = fausseAttribution();
    await balayerConversions(deps([[e]], attribution).outils);

    expect(attribution.appels).toHaveLength(0);
  });

  it("🔴 une identification survenue entre deux passages ne renvoie pas la conversion", async () => {
    // Le même défaut, vu de bout en bout : le premier passage voit l'achat
    // anonyme, `identify()` réécrit ClickHouse, le second passage relit la MÊME
    // ligne avec une identité. Une seule conversion doit exister.
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");

    await balayerConversions(deps([[evenement({ utilisateur: "empreinte-abc" })]]).outils);
    const second = await balayerConversions(deps([[evenement({ utilisateur: "user-42" })]]).outils);

    expect(second.inscrits).toBe(0);
    expect(await journal()).toHaveLength(1);
  });

  it("deux achats distincts produisent deux lignes", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const a = evenement({ horodatage: "2026-08-29T10:00:00Z", props: JSON.stringify({ total_eur: 42.9, ads_consent_ad_user_data: "granted" }) });
    const b = evenement({ horodatage: "2026-08-29T11:00:00Z", props: JSON.stringify({ total_eur: 17.5, ads_consent_ad_user_data: "granted" }) });

    const bilan = await balayerConversions(deps([[a, b]]).outils);

    expect(bilan.inscrits).toBe(2);
    const lignes = await journal();
    expect(lignes).toHaveLength(2);
    expect(new Set(lignes.map(l => l.business_event_id)).size).toBe(2);
  });

  it("deux lignes ClickHouse strictement identiques ne comptent qu'une conversion", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const e = evenement();

    const bilan = await balayerConversions(deps([[e, { ...e }]]).outils);

    expect(bilan.inscrits).toBe(1);
    expect(bilan.doublons).toBe(1);
    expect(await journal()).toHaveLength(1);
  });

  it("un site désactivé ne produit rien, et n'est même pas interrogé", async () => {
    await creerSite(1, { enabled: false });
    await creerCorrespondance(1, "order_confirmed");
    const d = deps([[evenement()]]);

    const bilan = await balayerConversions(d.outils);

    expect(bilan.sites).toBe(0);
    expect(bilan.inscrits).toBe(0);
    expect(d.lectures.specs).toHaveLength(0);
    expect(await journal()).toHaveLength(0);
  });

  it("un événement sans correspondance est ignoré", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const d = deps([[evenement({ eventName: "newsletter_signup" })]]);

    const bilan = await balayerConversions(d.outils);

    expect(bilan.inscrits).toBe(0);
    // La requête ne demande QUE les noms mappés : c'est le premier filtre.
    expect(d.lectures.specs[0].params.noms).toEqual(["order_confirmed"]);
    expect(await journal()).toHaveLength(0);
  });

  it("un site activé sans aucune correspondance n'interroge pas ClickHouse", async () => {
    await creerSite(1);
    const d = deps([[evenement()]]);

    const bilan = await balayerConversions(d.outils);

    expect(bilan.evenements).toBe(0);
    expect(d.lectures.specs).toHaveLength(0);
  });

  it("sans consentement publicitaire : aucune ligne, et AUCUNE attribution demandée", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const attribution = fausseAttribution();
    const d = deps([[evenement({ props: JSON.stringify({ total_eur: 10 }) })]], attribution);

    const bilan = await balayerConversions(d.outils);

    expect(bilan.ignoresSansConsentement).toBe(1);
    expect(bilan.inscrits).toBe(0);
    // 🔴 On ne va même pas CHERCHER l'identifiant de clic : ne rien envoyer ne
    // suffit pas, il ne faut pas non plus le stocker.
    expect(attribution.appels).toHaveLength(0);
    expect(await journal()).toHaveLength(0);
  });

  it("consentement explicitement refusé : même traitement", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const d = deps([[evenement({ props: JSON.stringify({ ads_consent_ad_user_data: "denied", total_eur: 10 }) })]]);

    const bilan = await balayerConversions(d.outils);

    expect(bilan.ignoresSansConsentement).toBe(1);
    expect(await journal()).toHaveLength(0);
  });

  it("un événement sans clic dans la fenêtre est ignoré sans erreur", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const d = deps([[evenement()]], fausseAttribution(null));

    const bilan = await balayerConversions(d.outils);

    expect(bilan.ignoresSansClic).toBe(1);
    expect(bilan.erreurs).toBe(0);
    expect(await journal()).toHaveLength(0);
  });

  it("une panne ClickHouse ne fait pas tomber le balayage et n'emporte pas les autres sites", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    await creerSite(2);
    await creerCorrespondance(2, "order_confirmed");

    let appel = 0;
    const bilan = await balayerConversions({
      base: db,
      maintenant: () => MAINTENANT,
      attribuer: fausseAttribution().fn,
      lireEvenements: async () => {
        appel += 1;
        if (appel === 1) throw new Error("ClickHouse indisponible");
        return [evenement()] as any;
      },
    });

    expect(bilan.erreurs).toBe(1);
    expect(bilan.inscrits).toBe(1);
    expect(await journal(2)).toHaveLength(1);
  });

  it("une panne d'attribution n'emporte que son événement", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const a = evenement({ horodatage: "2026-08-29T10:00:00Z" });
    const b = evenement({ horodatage: "2026-08-29T11:00:00Z" });

    let appel = 0;
    const bilan = await balayerConversions({
      base: db,
      maintenant: () => MAINTENANT,
      lireEvenements: async () => [a, b] as any,
      attribuer: (async (demande: any) => {
        appel += 1;
        if (appel === 1) throw new Error("ClickHouse indisponible");
        return {
          identifiant: { type: "gclid", valeur: "Cj0KCQjwReel", horodatage: CLIC },
          utilisateur: demande.utilisateur,
          appareils: [],
          clics: [],
        };
      }) as any,
    });

    expect(bilan.erreurs).toBe(1);
    expect(bilan.inscrits).toBe(1);
  });

  it("une troncature est SIGNALÉE, jamais silencieuse", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const lot = [0, 1, 2].map(n => evenement({ horodatage: `2026-08-29T10:00:0${n}Z` }));

    const bilan = await balayerSite(
      1,
      { base: db, lireEvenements: (async () => lot) as any, attribuer: fausseAttribution().fn, limite: 3 },
      MAINTENANT,
    );

    expect(bilan.tronques).toBe(1);
  });

  it("la valeur vient de l'événement, et à défaut de la correspondance", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed", "987654321", "25.00", "USD");
    const avecMontant = evenement({ horodatage: "2026-08-29T10:00:00Z" });
    const sansMontant = evenement({
      horodatage: "2026-08-29T11:00:00Z",
      props: JSON.stringify({ ads_consent_ad_user_data: "granted" }),
    });

    await balayerConversions(deps([[avecMontant, sansMontant]]).outils);

    const lignes = await journal();
    expect(Number(lignes[0].value)).toBe(42.9);
    expect(lignes[0].currency).toBe("EUR");
    // Repli sur la correspondance : `enregistrerConversion` le fait, on se
    // contente de lui passer `undefined`.
    expect(Number(lignes[1].value)).toBe(25);
    expect(lignes[1].currency).toBe("USD");
  });

  it("l'horodatage métier traverse sans décalage de fuseau", async () => {
    // Le fichier tourne sous America/New_York : un `new Date("...")` local
    // quelque part dans la chaîne décalerait la ligne de quatre heures.
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");

    await balayerConversions(deps([[evenement({ horodatage: "2026-08-29T10:00:00Z" })]]).outils);

    const lignes = await journal();
    expect(String(lignes[0].occurred_at)).toContain("10:00:00");
  });

  it("restreindre à un site n'en balaye qu'un", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    await creerSite(2);
    await creerCorrespondance(2, "order_confirmed");

    const bilan = await balayerConversions({ ...deps([[evenement()]]).outils, siteId: 2 });

    expect(bilan.sites).toBe(1);
    expect(await journal(1)).toHaveLength(0);
    expect(await journal(2)).toHaveLength(1);
  });

  it("l'attribution est interrogée avec l'identité de l'événement et son horodatage", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const attribution = fausseAttribution();

    await balayerConversions(deps([[evenement({ utilisateur: "user-99" })]], attribution).outils);

    expect(attribution.appels[0]).toMatchObject({ siteId: 1, utilisateur: "user-99" });
    expect(attribution.appels[0].conversionAt.toISOString()).toBe("2026-08-29T10:00:00.000Z");
  });
});

/* ─────────────────────── La chaîne, de bout en bout ─────────────────────── */

describe("la chaîne complète : événement mesuré → Google", () => {
  /**
   * 🔴 LE test qui aurait attrapé le défaut du 2026-08-29.
   *
   * Chaque pièce du module était couverte et verte : 218 tests, 100 % de
   * couverture, une preuve réseau réelle. Et pourtant rien ne partait, parce
   * qu'aucun test ne demandait « un événement mesuré finit-il chez Google ? ».
   *
   * Ici, tout ce qui sépare ClickHouse de la charge utile Google est le VRAI
   * code : le balayage, l'identifiant métier, l'écriture au journal, la
   * réclamation du lot, les règles d'envoi, le regroupement par destination. Ne
   * sont simulés que les deux bouts qu'on ne peut pas tenir dans un test — la
   * lecture ClickHouse et l'appel réseau.
   */
  it("un événement mesuré arrive chez Google avec sa clé d'idempotence", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed", "987654321");

    const bilanBalayage = await balayerConversions(deps([[evenement()]]).outils);
    expect(bilanBalayage.inscrits).toBe(1);

    const envois: any[] = [];
    const bilanDrain = await drainerConversions({
      base: db,
      credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" },
      maintenant: () => MAINTENANT,
      ingest: (async (_c: unknown, destination: unknown, evenements: any[]) => {
        envois.push({ destination, evenements });
        return { requestId: "req-1", eventCount: evenements.length, validateOnly: false } as IngestResult;
      }) as any,
    });

    expect(bilanDrain.envoyees).toBe(1);
    expect(envois).toHaveLength(1);
    expect(envois[0].destination).toMatchObject({ operatingAccountId: "2568911678", conversionActionId: "987654321" });

    const envoye = envois[0].evenements[0];
    expect(envoye.gclid).toBe("Cj0KCQjwReel");
    expect(envoye.value).toBe(42.9);
    expect(envoye.occurredAt).toBe("2026-08-29T10:00:00.000Z");
    expect(envoye.consent).toEqual({ adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" });
    // La clé d'idempotence de Google, celle qui garantit qu'un rejeu ne compte
    // pas deux fois : elle DOIT porter l'identifiant métier fabriqué ici.
    expect(envoye.transactionId).toBe(`1:${identifiantEvenementMetier(evenement())}:987654321`);
  });

  it("un rejeu complet de la chaîne n'envoie pas une seconde conversion", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const e = evenement();

    await balayerConversions(deps([[e]]).outils);
    await balayerConversions(deps([[e]]).outils);

    const envois: any[] = [];
    await drainerConversions({
      base: db,
      credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" },
      maintenant: () => MAINTENANT,
      ingest: (async (_c: unknown, _d: unknown, evenements: any[]) => {
        envois.push(...evenements);
        return { requestId: "req-1", eventCount: evenements.length, validateOnly: false } as IngestResult;
      }) as any,
    });

    expect(envois).toHaveLength(1);
  });

  it("un site désactivé ne fait rien partir, même avec du trafic payant", async () => {
    await creerSite(1, { enabled: false });
    await creerCorrespondance(1, "order_confirmed");

    await balayerConversions(deps([[evenement()]]).outils);

    const envois: any[] = [];
    const bilan = await drainerConversions({
      base: db,
      credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" },
      maintenant: () => MAINTENANT,
      ingest: (async (_c: unknown, _d: unknown, evenements: any[]) => {
        envois.push(...evenements);
        return { requestId: "req-1", eventCount: evenements.length, validateOnly: false } as IngestResult;
      }) as any,
    });

    expect(bilan.reclamees).toBe(0);
    expect(envois).toHaveLength(0);
  });
});

/* Sanity : le bilan totalise bien ce qu'il a vu. */
describe("bilan", () => {
  it("chaque événement lu tombe dans exactement une catégorie", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");

    const lot = [
      evenement({ horodatage: "2026-08-29T10:00:00Z" }), // inscrit
      evenement({ horodatage: "2026-08-29T10:00:01Z", props: "{}" }), // sans consentement
      evenement({ horodatage: "2026-08-29T10:00:02Z" }), // inscrit
    ];

    const bilan: BilanBalayage = await balayerConversions(deps([lot]).outils);

    const classes =
      bilan.inscrits + bilan.dejaConnus + bilan.doublons + bilan.ignoresSansConsentement + bilan.ignoresSansClic + bilan.erreurs;
    expect(bilan.evenements).toBe(3);
    expect(classes).toBe(3);
  });
});

/* ───────── Le bilan persisté : trois états qui se confondaient ──────────── */

describe("bilan persisté du dernier passage", () => {
  /**
   * 🔴 Le cœur de ce bloc.
   *
   * Trois situations produisaient jusqu'ici le MÊME écran, « 0 en attente,
   * 0 envoyé » : la tâche planifiée qui ne tourne pas, le site calme, et le site
   * dont chaque événement est écarté. La première et la troisième sont des
   * pannes, la deuxième est normale. Les tests ci-dessous prouvent qu'elles ne
   * se ressemblent plus.
   */
  it("« jamais tourné » n'écrit rien : c'est le témoin d'une tâche planifiée morte", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");

    expect(await bilanPersiste()).toBeNull();
  });

  it("« site calme » : le passage laisse une trace, à zéro événement", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");

    await balayerConversions(deps([[]]).outils);

    const b = await bilanPersiste();
    expect(b).not.toBeNull();
    expect(b.events_examined).toBe(0);
    expect(b.unmapped_events).toBe(0);
    expect(String(b.last_run_at)).toContain("12:00:00");
  });

  it("🔴 « tout écarté » ne ressemble PAS à un site calme", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const lot = [0, 1, 2].map(n =>
      evenement({ horodatage: `2026-08-29T10:00:0${n}Z`, props: "{}" }),
    );

    await balayerConversions(deps([lot]).outils);

    const b = await bilanPersiste();
    expect(b.events_examined).toBe(3);
    expect(b.recorded).toBe(0);
    expect(b.skipped_no_consent).toBe(3);
  });

  it("le passage qui produit se distingue des deux autres", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");

    await balayerConversions(deps([[evenement()]]).outils);

    const b = await bilanPersiste();
    expect(b.events_examined).toBe(1);
    expect(b.recorded).toBe(1);
  });

  it("un site activé SANS correspondance laisse quand même une trace", async () => {
    // Chemin de sortie anticipé : sans écriture dans un `finally`, ce site
    // resterait « jamais tourné », donc confondu avec un cron mort.
    await creerSite(1);

    await balayerConversions(deps([[]]).outils);

    expect(await bilanPersiste()).not.toBeNull();
  });

  it("un site en panne laisse une trace, avec son erreur", async () => {
    // Même raison : une panne permanente ne doit pas se déguiser en cron mort.
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");

    await balayerConversions({
      base: db,
      maintenant: () => MAINTENANT,
      compterNonMappes: (async () => []) as any,
      lireEvenements: (async () => {
        throw new Error("ClickHouse indisponible");
      }) as any,
    });

    const b = await bilanPersiste();
    expect(b).not.toBeNull();
    expect(b.errors).toBe(1);
    expect(b.recorded).toBe(0);
  });

  it("le bilan est ÉCRASÉ, pas empilé : on veut le dernier état", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");

    await balayerConversions(deps([[evenement()]]).outils);
    await balayerConversions(deps([[]]).outils);

    const r = await client.query(`SELECT count(*)::int AS n FROM ads_scan_state WHERE site_id = 1`);
    expect((r.rows[0] as any).n).toBe(1);
    const b = await bilanPersiste();
    expect(b.events_examined).toBe(0);
    expect(b.recorded).toBe(0);
  });

  it("une troncature est reportée dans le bilan persisté", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    const lot = [0, 1, 2].map(n => evenement({ horodatage: `2026-08-29T10:00:0${n}Z` }));

    await balayerSite(
      1,
      {
        base: db,
        lireEvenements: (async () => lot) as any,
        compterNonMappes: (async () => []) as any,
        attribuer: fausseAttribution().fn,
        limite: 3,
      },
      MAINTENANT,
    );

    expect((await bilanPersiste()).truncated).toBe(true);
  });

  it("une écriture de bilan en échec ne fait pas tomber le balayage", async () => {
    // Le compte rendu est moins important que le travail : le perdre ne doit
    // jamais coûter les conversions du passage.
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");
    await client.exec(`DROP TABLE "ads_scan_state";`);

    const bilan = await balayerConversions(deps([[evenement()]]).outils);

    expect(bilan.inscrits).toBe(1);
    await client.exec(`
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
    `);
  });
});

describe("les événements qu'aucune correspondance ne couvre", () => {
  it("🔴 un site qui émet sous d'autres noms n'est PAS un site calme", async () => {
    // La panne la plus banale : la correspondance dit `order_paid`, le site émet
    // `order_confirmed`. La requête principale ne lit rien, donc tous les
    // compteurs valent zéro, et l'écran est celui d'un site sans trafic.
    await creerSite(1);
    await creerCorrespondance(1, "order_paid");

    await balayerConversions({
      base: db,
      maintenant: () => MAINTENANT,
      lireEvenements: (async () => []) as any,
      compterNonMappes: (async () => [
        { eventName: "order_confirmed", n: 12 },
        { eventName: "cart_viewed", n: 40 },
      ]) as any,
      attribuer: fausseAttribution().fn,
    });

    const b = await bilanPersiste();
    expect(b.events_examined).toBe(0);
    expect(b.unmapped_events).toBe(52);
    expect(b.unmapped_top_names).toContain("order_confirmed");
  });

  it("le comptage tourne AUSSI quand le site n'a aucune correspondance", async () => {
    await creerSite(1);
    const specs: any[] = [];

    await balayerConversions({
      base: db,
      maintenant: () => MAINTENANT,
      lireEvenements: (async () => []) as any,
      compterNonMappes: (async (spec: any) => {
        specs.push(spec);
        return [{ eventName: "order_confirmed", n: 3 }];
      }) as any,
    });

    expect(specs).toHaveLength(1);
    expect(specs[0].params.noms).toEqual([]);
    expect((await bilanPersiste()).unmapped_events).toBe(3);
  });

  it("une panne du comptage n'empêche pas le balayage de travailler", async () => {
    await creerSite(1);
    await creerCorrespondance(1, "order_confirmed");

    const bilan = await balayerConversions({
      base: db,
      maintenant: () => MAINTENANT,
      lireEvenements: (async () => [evenement()]) as any,
      compterNonMappes: (async () => {
        throw new Error("ClickHouse indisponible");
      }) as any,
      attribuer: fausseAttribution().fn,
    });

    expect(bilan.inscrits).toBe(1);
    expect(bilan.nonMappes).toBe(0);
  });

  it("la requête de comptage est paramétrée et écarte les pages vues", () => {
    const spec = construireRequeteNonMappes({
      siteId: 1,
      noms: ["order_confirmed", "'; DROP TABLE events; --"],
      debut: MAINTENANT,
      fin: MAINTENANT,
    });
    expect(spec.query).not.toContain("DROP TABLE");
    expect(spec.query).toContain("event_name != ''");
    expect(spec.query).toContain("NOT IN ({noms:Array(String)})");
    expect(spec.params?.noms).toHaveLength(2);
  });
});
