/**
 * Ce que ce fichier protège.
 *
 * La collecte ne décide rien — elle remplit les entrées d'une fonction pure. Ses
 * défauts sont donc tous du même genre : un chiffre faux mais plausible, qui
 * traverse le diagnostic sans lever la moindre erreur et rend un verdict
 * parfaitement formaté sur des données fausses. Trois d'entre eux sont
 * spécifiquement piégés ici :
 *
 *  - **la fenêtre décalée par le fuseau du serveur.** `timestamp` est un
 *    `DateTime` SANS fuseau que ClickHouse rend dans le fuseau du SERVEUR. D'où
 *    le `TZ` décalé en tête de fichier : sous le `TZ=UTC` d'une CI, une borne
 *    mal ancrée passerait tous les tests et décalerait la période de deux heures
 *    en production ;
 *  - **un dénominateur reconstitué.** Le compte des noms distincts et le total
 *    des lignes viennent de la requête de totaux, jamais du détail par événement
 *    qui est borné aux plus fréquents ;
 *  - **une lacune déguisée en zéro.** Quand la lecture du trafic robot échoue,
 *    `traficRobot` reste `null`. Un `0` se lirait « aucun robot », et le rapport
 *    affirmerait tranquillement quelque chose qu'il ignore.
 *
 * ClickHouse et Postgres sont simulés : ce sont des LECTURES, et le point à
 * démontrer est ce qu'on fait des lignes, pas que ClickHouse sait agréger.
 */
process.env.TZ = "America/New_York";

import { beforeEach, describe, expect, it, vi } from "vitest";

const requetes = vi.hoisted(() => ({
  appels: [] as { query: string; params?: Record<string, unknown> }[],
  reponses: new Map<string, unknown[]>(),
  echecs: new Set<string>(),
}));

const reglages = vi.hoisted(() => ({
  correspondances: [] as { eventName: string; conversionActionId: string }[],
  site: null as { enabled: boolean } | null,
}));

/**
 * Le routage se fait sur un fragment du SQL et non sur l'ordre des appels : les
 * trois requêtes partent en parallèle, et un test qui dépendrait de leur ordre
 * casserait au premier `Promise.all` réordonné.
 */
vi.mock("../analytics/utils/analyticsQuery.js", () => ({
  runAnalyticsQuery: async (spec: { query: string; params?: Record<string, unknown> }) => {
    requetes.appels.push(spec);
    const genre = spec.query.includes("bot_events") ? "robots" : spec.query.includes("GROUP BY nom") ? "evenements" : "totaux";
    if (requetes.echecs.has(genre)) throw new Error(`échec simulé : ${genre}`);
    return requetes.reponses.get(genre) ?? [];
  },
  AnalyticsQueryError: class extends Error {},
}));

vi.mock("../ads/settings.js", () => ({
  listerCorrespondances: async () => reglages.correspondances,
  lireReglages: async () => reglages.site,
}));

import {
  collecterEntrees,
  construireFenetre,
  construireRequeteEvenements,
  construireRequeteRobots,
  construireRequeteTotaux,
  SEUIL_PROPS_PRESQUE_LONGUES,
} from "./collecte.js";

const FENETRE = {
  debut: new Date("2026-07-30T00:00:00.000Z"),
  fin: new Date("2026-08-29T00:00:00.000Z"),
  jours: 30,
};

beforeEach(() => {
  requetes.appels = [];
  requetes.reponses = new Map();
  requetes.echecs = new Set();
  reglages.correspondances = [];
  reglages.site = null;
});

/* ──────────────────────────── La fenêtre ────────────────────────────────── */

describe("construireFenetre", () => {
  const maintenant = new Date("2026-08-29T12:00:00.000Z");

  it("retombe sur 30 jours pour toute saisie illisible", () => {
    for (const saisie of [undefined, "", "abc", null, {}, NaN]) {
      expect(construireFenetre(saisie, maintenant).jours).toBe(30);
    }
  });

  it("borne la fenêtre entre 1 et 90 jours", () => {
    expect(construireFenetre("0", maintenant).jours).toBe(1);
    expect(construireFenetre("-5", maintenant).jours).toBe(1);
    expect(construireFenetre("100000", maintenant).jours).toBe(90);
    expect(construireFenetre("7", maintenant).jours).toBe(7);
  });

  it("cale le début sur la durée retenue, pas sur la saisie", () => {
    const fenetre = construireFenetre("1000", maintenant);
    const ecart = (fenetre.fin.getTime() - fenetre.debut.getTime()) / (24 * 3600 * 1000);
    expect(ecart).toBe(90);
  });
});

/* ─────────────────────────── Les requêtes ───────────────────────────────── */

describe("les requêtes sont paramétrées et ancrées sur UTC", () => {
  const specs = [
    ["événements", construireRequeteEvenements({ siteId: 42, ...FENETRE })],
    ["totaux", construireRequeteTotaux({ siteId: 42, ...FENETRE })],
    ["robots", construireRequeteRobots({ siteId: 42, ...FENETRE })],
  ] as const;

  it.each(specs)("%s : aucune valeur n'est concaténée dans le SQL", (_nom, spec) => {
    // L'identifiant de site et les bornes ne doivent apparaître QUE dans les
    // paramètres liés. Un `site_id = 42` en dur signalerait une concaténation.
    expect(spec.query).not.toContain("42");
    expect(spec.query).not.toContain("2026-");
    expect(spec.params?.siteId).toBe(42);
  });

  it.each(specs)("%s : les deux bornes sont ancrées sur UTC", (_nom, spec) => {
    // 🔴 Sans le second argument, ClickHouse interprète la borne dans le fuseau
    // du serveur : la fenêtre glisse, silencieusement, et le diagnostic conclut
    // sur une autre période que celle qu'il annonce.
    expect(spec.query).toContain("toDateTime({debut:String}, 'UTC')");
    expect(spec.query).toContain("toDateTime({fin:String}, 'UTC')");
    expect(spec.params?.debut).toBe("2026-07-30 00:00:00");
    expect(spec.params?.fin).toBe("2026-08-29 00:00:00");
  });

  it("l'agrégat passe les listes de clés en paramètres, jamais en littéraux", () => {
    const spec = construireRequeteEvenements({ siteId: 42, ...FENETRE });

    expect(spec.query).toContain("{clesValeur:Array(String)}");
    expect(spec.query).toContain("{clesIdentifiant:Array(String)}");
    expect(spec.query).toContain("{clesConsentement:Array(String)}");
    // Les listes viennent de `ads/balayage.ts` et ne sont jamais recopiées :
    // deux listes qui divergeraient rendraient un diagnostic vert sur un site
    // dont rien ne part.
    expect(spec.params?.clesIdentifiant).toContain("checkout_session_id");
    expect(spec.params?.clesConsentement).toContain("ads_consent_ad_user_data");
    expect(spec.params?.clesValeur).toContain("total_eur");
    expect(spec.params?.seuilProps).toBe(SEUIL_PROPS_PRESQUE_LONGUES);
  });

  it("l'agrégat écarte les pages vues, qui n'ont pas de nom", () => {
    // Sans ce filtre, tout le trafic remonterait sous un nom vide et le
    // diagnostic conclurait à un événement métier par page vue.
    expect(construireRequeteEvenements({ siteId: 42, ...FENETRE }).query).toContain("event_name != ''");
  });

  it("lit la valeur sans confondre « illisible » et « zéro »", () => {
    const query = construireRequeteEvenements({ siteId: 42, ...FENETRE }).query;
    // `JSONExtractFloat` rendrait 0 sur `"49,90 €"`, indistinguable d'un montant
    // nul : c'est précisément la distinction que le diagnostic doit rendre.
    expect(query).not.toContain("JSONExtractFloat");
    expect(query).toContain("toFloat64OrNull");
  });

  it("compte les noms distincts dans les totaux, pas dans le détail borné", () => {
    // Le détail est limité aux noms les plus fréquents : en déduire le compte
    // plafonnerait le compteur juste sous la limite qu'il sert à surveiller.
    expect(construireRequeteTotaux({ siteId: 42, ...FENETRE }).query).toContain("uniqExactIf(event_name");
  });
});

/* ─────────────────────────── La collecte ────────────────────────────────── */

describe("collecterEntrees", () => {
  function peupler() {
    requetes.reponses.set("evenements", [
      {
        nom: "order_confirmed",
        // ClickHouse rend les entiers 64 bits en CHAÎNE : tout doit repasser par
        // une conversion, sinon les comparaisons de seuils comparent du texte.
        total: "120",
        sessions: "118",
        avecValeur: "120",
        valeurNonNumerique: "0",
        avecIdentifiant: "120",
        avecConsentement: "120",
        valeurMin: "19.9",
        valeurMax: "240",
        valeurMediane: "49.9",
        propsPresqueLongues: "0",
        propsTailleMax: "320",
      },
    ]);
    requetes.reponses.set("totaux", [
      { pagesVues: "42000", lignes: "48730", traficDatacenter: "300", nomsDistincts: "12" },
    ]);
    requetes.reponses.set("robots", [{ robots: "1800" }]);
  }

  it("convertit les chaînes de ClickHouse en nombres", async () => {
    peupler();
    const entrees = await collecterEntrees(42, FENETRE);

    expect(entrees.pagesVues).toBe(42000);
    expect(entrees.totalLignes).toBe(48730);
    expect(entrees.nomsDistincts).toBe(12);
    expect(entrees.traficRobot).toBe(1800);
    expect(entrees.evenements[0]).toMatchObject({ nom: "order_confirmed", total: 120, valeurMediane: 49.9 });
    expect(entrees.periode).toEqual({
      debut: "2026-07-30T00:00:00.000Z",
      fin: "2026-08-29T00:00:00.000Z",
      jours: 30,
    });
  });

  it("garde null pour une valeur jamais lue, au lieu de la ramener à zéro", async () => {
    peupler();
    requetes.reponses.set("evenements", [
      { nom: "newsletter_subscribed", total: "40", sessions: "40", avecValeur: "0", valeurNonNumerique: "0", avecIdentifiant: "0", avecConsentement: "40", valeurMin: null, valeurMax: null, valeurMediane: null, propsPresqueLongues: "0", propsTailleMax: "90" },
    ]);

    const entrees = await collecterEntrees(42, FENETRE);
    // 🔴 `valeurMediane: 0` déclencherait « montant hors de l'ordre de grandeur »
    // sur un événement qui n'a simplement jamais porté de montant.
    expect(entrees.evenements[0]!.valeurMediane).toBeNull();
    expect(entrees.evenements[0]!.valeurMin).toBeNull();
  });

  it("laisse traficRobot à null quand sa lecture échoue, et ne le ramène pas à zéro", async () => {
    peupler();
    requetes.echecs.add("robots");
    const warn = vi.fn();

    const entrees = await collecterEntrees(42, FENETRE, { logger: { warn } });

    expect(entrees.traficRobot).toBeNull();
    expect(entrees.pagesVues).toBe(42000); // le reste du rapport reste valable
    expect(warn).toHaveBeenCalled();
  });

  it("laisse remonter l'échec des lectures qui portent le diagnostic", async () => {
    peupler();
    requetes.echecs.add("evenements");

    // Rendre un rapport partiel en le présentant comme complet fabriquerait
    // exactement le défaut que ce module existe pour attraper.
    await expect(collecterEntrees(42, FENETRE)).rejects.toThrow(/évén|evenements/);
  });

  it("distingue « aucun réglage publicitaire » de « envoi désactivé »", async () => {
    peupler();

    reglages.site = null;
    expect((await collecterEntrees(42, FENETRE)).adsActif).toBeNull();

    reglages.site = { enabled: false };
    expect((await collecterEntrees(42, FENETRE)).adsActif).toBe(false);

    reglages.site = { enabled: true };
    expect((await collecterEntrees(42, FENETRE)).adsActif).toBe(true);
  });

  it("remonte les correspondances configurées telles quelles", async () => {
    peupler();
    reglages.correspondances = [{ eventName: "order_paid", conversionActionId: "987654321" }];

    const entrees = await collecterEntrees(42, FENETRE);
    expect(entrees.correspondances).toEqual([{ eventName: "order_paid", conversionActionId: "987654321" }]);
  });

  it("rend des zéros francs quand la période est vide, sans planter", async () => {
    // Aucune réponse : le site n'a rien reçu. Les entrées doivent être lisibles,
    // c'est `mesure.ts` qui décide que ça s'appelle « pas de données ».
    const entrees = await collecterEntrees(42, FENETRE);

    expect(entrees.pagesVues).toBe(0);
    expect(entrees.totalLignes).toBe(0);
    expect(entrees.evenements).toEqual([]);
    expect(entrees.traficRobot).toBe(0);
  });
});
