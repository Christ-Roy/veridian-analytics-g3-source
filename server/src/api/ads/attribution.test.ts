import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * File de résultats Postgres, consommée dans l'ordre des `select()` du module.
 * Même motif que `getUserByEmail.test.ts` : la chaîne Drizzle est simulée, la
 * logique de résolution d'alias reste réelle — c'est elle qu'on teste.
 */
const etatDb = vi.hoisted(() => ({
  resultats: [] as unknown[][],
  clauses: [] as unknown[],
}));

vi.mock("../../db/postgres/postgres.js", () => {
  const chaine: Record<string, unknown> = {};
  const soi = () => chaine;
  chaine.from = soi;
  chaine.limit = soi;
  chaine.where = (clause: unknown) => {
    etatDb.clauses.push(clause);
    return chaine;
  };
  chaine.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(etatDb.resultats.shift() ?? []).then(resolve, reject);
  return { db: { select: () => chaine } };
});

/** ClickHouse n'est pas joint : on capture la requête et on rend des lignes. */
const etatCh = vi.hoisted(() => ({
  specs: [] as { query: string; params?: Record<string, unknown> }[],
  lignes: [] as unknown[],
  erreur: null as Error | null,
}));

vi.mock("../analytics/utils/analyticsQuery.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../analytics/utils/analyticsQuery.js")>();
  return {
    ...actual,
    runAnalyticsQuery: async (spec: { query: string; params?: Record<string, unknown> }) => {
      etatCh.specs.push(spec);
      if (etatCh.erreur) throw etatCh.erreur;
      return etatCh.lignes;
    },
  };
});

const {
  FENETRE_CLIC_JOURS,
  LIMITE_CLICS,
  appartientAUtilisateur,
  choisirIdentifiant,
  construireRequeteClic,
  resoudreAppareils,
  retrouverIdentifiantClic,
} = await import("./attribution.js");
type LigneClic = import("./attribution.js").LigneClic;

const CONVERSION = new Date("2026-08-27T10:00:00.000Z");

function ligne(overrides: Partial<LigneClic> = {}): LigneClic {
  return { horodatage: "2026-08-24T09:00:00Z", gclid: "", gbraid: "", wbraid: "", ...overrides };
}

beforeEach(() => {
  etatDb.resultats = [];
  etatDb.clauses = [];
  etatCh.specs = [];
  etatCh.lignes = [];
  etatCh.erreur = null;
});

describe("construireRequeteClic", () => {
  const base = {
    siteId: 42,
    utilisateur: "u-1",
    appareils: ["fp-a", "fp-b"],
    conversionAt: CONVERSION,
  };

  it("ne concatène aucune valeur dans le SQL", () => {
    const { query } = construireRequeteClic({
      ...base,
      utilisateur: "'; DROP TABLE events; --",
      appareils: ["'; DROP TABLE events; --"],
    });
    expect(query).not.toContain("DROP TABLE");
  });

  it("lie site, identité, appareils et bornes en paramètres", () => {
    const { params } = construireRequeteClic(base);
    expect(params).toEqual({
      siteId: 42,
      utilisateur: "u-1",
      appareils: ["fp-a", "fp-b"],
      debut: "2026-05-29 10:00:00",
      fin: "2026-08-27 10:00:00",
      limite: LIMITE_CLICS,
    });
  });

  it("borne la fenêtre à 90 jours avant la conversion, la valeur qu'accepte Google", () => {
    const { params } = construireRequeteClic(base);
    const debut = new Date(`${(params!.debut as string).replace(" ", "T")}Z`);
    const jours = (CONVERSION.getTime() - debut.getTime()) / (24 * 60 * 60 * 1000);
    expect(jours).toBe(90);
    expect(FENETRE_CLIC_JOURS).toBe(90);
  });

  it("accepte une fenêtre plus courte", () => {
    const { params } = construireRequeteClic({ ...base, fenetreJours: 30 });
    expect(params!.debut).toBe("2026-07-28 10:00:00");
  });

  it("n'accepte aucun clic postérieur à la conversion", () => {
    const { query } = construireRequeteClic(base);
    expect(query).toContain("timestamp <= toDateTime({fin:String}, 'UTC')");
  });

  it("ancre les DEUX bornes sur UTC — la colonne est un DateTime sans fuseau", () => {
    // Sans le `'UTC'`, ClickHouse parse la chaîne dans le fuseau du SERVEUR :
    // une borne calculée en UTC serait lue décalée sur un serveur en Europe/Paris.
    const { query } = construireRequeteClic(base);
    expect(query).toContain("toDateTime({debut:String}, 'UTC')");
    expect(query).toContain("toDateTime({fin:String}, 'UTC')");
    expect(query).not.toMatch(/toDateTime\(\{(debut|fin):String\}\)/);
  });

  it("rend l'horodatage du clic en RFC 3339 UTC, sans passer par %M", () => {
    // `%M` est le MOIS EN TOUTES LETTRES dans formatDateTime : le format naïf
    // rend « 2026-08-29T10:August:22Z ». Mesuré en production le 2026-08-29.
    const { query } = construireRequeteClic(base);
    expect(query).toContain("formatDateTime(timestamp, '%FT%TZ', 'UTC') AS horodatage");
    expect(query).not.toContain("%M");
    expect(query).not.toContain("toString(timestamp)");
  });

  it("normalise les bornes pour toDateTime, qui refuse un Z", () => {
    const { params } = construireRequeteClic(base);
    expect(params!.fin).not.toMatch(/Z$/);
    expect(params!.fin).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("lit les trois identifiants dans url_parameters, jamais la colonne channel", () => {
    const { query } = construireRequeteClic(base);
    expect(query).toContain("url_parameters['gclid'] AS gclid");
    expect(query).toContain("url_parameters['gbraid'] AS gbraid");
    expect(query).toContain("url_parameters['wbraid'] AS wbraid");
    expect(query).not.toContain("channel");
  });

  it("écarte les événements sans aucun identifiant de clic", () => {
    const { query } = construireRequeteClic(base);
    expect(query).toContain("url_parameters['gclid'] != ''");
    expect(query).toContain("url_parameters['gbraid'] != ''");
    expect(query).toContain("url_parameters['wbraid'] != ''");
  });

  it("couvre l'identité ET les appareils anonymes liés", () => {
    const { query } = construireRequeteClic(base);
    expect(query).toContain(appartientAUtilisateur());
    // branche identifiée, réutilisée du dépôt
    expect(query).toContain("identified_user_id = {utilisateur:String}");
    // branche appareil, gardée pour ne pas ramasser le clic d'un voisin d'IP
    expect(query).toContain("user_id IN ({appareils:Array(String)}) AND identified_user_id = ''");
  });

  it("trie du plus récent au plus ancien pour le dernier clic, et l'inverse pour le premier", () => {
    expect(construireRequeteClic(base).query).toContain("ORDER BY timestamp DESC");
    expect(construireRequeteClic({ ...base, strategie: "premier" }).query).toContain("ORDER BY timestamp ASC");
  });

  it("retombe sur l'identité quand aucun appareil n'est connu", () => {
    const { params } = construireRequeteClic({ ...base, appareils: [] });
    expect(params!.appareils).toEqual(["u-1"]);
  });
});

describe("choisirIdentifiant", () => {
  it("rend null quand il n'y a aucun clic", () => {
    expect(choisirIdentifiant([])).toBeNull();
  });

  it("ignore les lignes dont les trois identifiants sont vides", () => {
    expect(choisirIdentifiant([ligne()])).toBeNull();
  });

  it("retient le clic le plus récent en dernier-clic", () => {
    const clics = [
      ligne({ horodatage: "2026-08-20T08:00:00Z", gclid: "vieux" }),
      ligne({ horodatage: "2026-08-26T08:00:00Z", gclid: "recent" }),
    ];
    expect(choisirIdentifiant(clics)).toEqual({
      type: "gclid",
      valeur: "recent",
      horodatage: "2026-08-26T08:00:00Z",
    });
  });

  it("retient le clic le plus ancien en premier-clic", () => {
    const clics = [
      ligne({ horodatage: "2026-08-26T08:00:00Z", gclid: "recent" }),
      ligne({ horodatage: "2026-08-20T08:00:00Z", gclid: "vieux" }),
    ];
    expect(choisirIdentifiant(clics, "premier")!.valeur).toBe("vieux");
  });

  it("ne dépend pas de l'ordre dans lequel les lignes arrivent", () => {
    const clics = [
      ligne({ horodatage: "2026-08-20T08:00:00Z", gclid: "a" }),
      ligne({ horodatage: "2026-08-26T08:00:00Z", gclid: "b" }),
      ligne({ horodatage: "2026-08-22T08:00:00Z", gclid: "c" }),
    ];
    expect(choisirIdentifiant([...clics].reverse())!.valeur).toBe("b");
    expect(choisirIdentifiant([...clics].reverse(), "premier")!.valeur).toBe("a");
  });

  it("préfère gclid à gbraid et wbraid sur un même événement", () => {
    const clic = ligne({ gclid: "G", gbraid: "B", wbraid: "W" });
    expect(choisirIdentifiant([clic])).toMatchObject({ type: "gclid", valeur: "G" });
  });

  it("préfère gbraid à wbraid quand le gclid manque", () => {
    expect(choisirIdentifiant([ligne({ gbraid: "B", wbraid: "W" })])).toMatchObject({ type: "gbraid", valeur: "B" });
  });

  it("remonte un wbraid seul — un clic YouTube ne doit pas être perdu", () => {
    expect(choisirIdentifiant([ligne({ wbraid: "W" })])).toMatchObject({ type: "wbraid", valeur: "W" });
  });

  it("départage deux événements de la même seconde par la priorité, pas par l'ordre de lecture", () => {
    const clics = [
      ligne({ horodatage: "2026-08-26T08:00:00Z", wbraid: "W" }),
      ligne({ horodatage: "2026-08-26T08:00:00Z", gclid: "G" }),
    ];
    expect(choisirIdentifiant(clics)!.valeur).toBe("G");
    expect(choisirIdentifiant([...clics].reverse())!.valeur).toBe("G");
  });

  it("préfère un gbraid récent à un gclid plus ancien — c'est le clic qui décide, pas le type", () => {
    const clics = [
      ligne({ horodatage: "2026-08-20T08:00:00Z", gclid: "vieux" }),
      ligne({ horodatage: "2026-08-26T08:00:00Z", gbraid: "recent" }),
    ];
    expect(choisirIdentifiant(clics)).toMatchObject({ type: "gbraid", valeur: "recent" });
  });

  it("conserve la casse exacte — Google la lit, une normalisation invaliderait le clic", () => {
    const valeur = "EAIaIQobChMI_aBcDeF-GhIjKlM";
    expect(choisirIdentifiant([ligne({ gclid: valeur })])!.valeur).toBe(valeur);
  });
});

describe("resoudreAppareils", () => {
  it("remonte les appareils d'une identité connue", async () => {
    etatDb.resultats = [[{ anonymousId: "fp-a" }, { anonymousId: "fp-b" }]];
    const lies = await resoudreAppareils(7, "u-1");
    expect(lies).toEqual({ utilisateur: "u-1", appareils: ["u-1", "fp-a", "fp-b"] });
  });

  it("remonte à l'identité PUIS redescend sur ses autres appareils", async () => {
    etatDb.resultats = [
      [], // "fp-a" n'est pas une identité
      [{ userId: "u-1" }], // c'est l'empreinte d'un appareil de u-1
      [{ anonymousId: "fp-a" }, { anonymousId: "fp-b" }], // les deux appareils de u-1
    ];
    const lies = await resoudreAppareils(7, "fp-a");
    // fp-b est le second appareil : sans lui, l'achat au téléphone ne verrait
    // jamais le clic reçu sur l'ordinateur.
    expect(lies).toEqual({ utilisateur: "u-1", appareils: ["fp-a", "fp-b"] });
  });

  it("rend l'entrée telle quelle quand rien n'est lié", async () => {
    etatDb.resultats = [[], []];
    expect(await resoudreAppareils(7, "fp-seul")).toEqual({ utilisateur: "fp-seul", appareils: ["fp-seul"] });
  });

  it("ne duplique pas l'entrée quand elle figure déjà parmi les appareils", async () => {
    etatDb.resultats = [[], [{ userId: "u-1" }], [{ anonymousId: "fp-a" }]];
    expect((await resoudreAppareils(7, "fp-a")).appareils).toEqual(["fp-a"]);
  });
});

describe("retrouverIdentifiantClic", () => {
  it("interroge tous les appareils liés et rend le dernier clic", async () => {
    etatDb.resultats = [[{ anonymousId: "fp-a" }, { anonymousId: "fp-b" }]];
    etatCh.lignes = [
      ligne({ horodatage: "2026-08-24T09:00:00Z", gclid: "EAIaLundi" }),
      ligne({ horodatage: "2026-06-01T09:00:00Z", gclid: "EAIaVieux" }),
    ];

    const resultat = await retrouverIdentifiantClic({ siteId: 7, utilisateur: "u-1", conversionAt: CONVERSION });

    expect(etatCh.specs[0].params!.appareils).toEqual(["u-1", "fp-a", "fp-b"]);
    expect(resultat.identifiant).toEqual({
      type: "gclid",
      valeur: "EAIaLundi",
      horodatage: "2026-08-24T09:00:00Z",
    });
    expect(resultat.utilisateur).toBe("u-1");
    expect(resultat.clics).toHaveLength(2);
  });

  it("retrouve le clic reçu sur un AUTRE appareil que celui de la conversion", async () => {
    etatDb.resultats = [[], [{ userId: "u-1" }], [{ anonymousId: "fp-mobile" }, { anonymousId: "fp-bureau" }]];
    etatCh.lignes = [ligne({ gclid: "EAIaBureau" })];

    const resultat = await retrouverIdentifiantClic({
      siteId: 7,
      utilisateur: "fp-mobile",
      conversionAt: CONVERSION,
    });

    expect(etatCh.specs[0].params!.utilisateur).toBe("u-1");
    expect(etatCh.specs[0].params!.appareils).toEqual(["fp-mobile", "fp-bureau"]);
    expect(resultat.identifiant!.valeur).toBe("EAIaBureau");
  });

  it("rend un résultat VIDE, jamais une erreur, quand la personne n'a jamais cliqué", async () => {
    etatDb.resultats = [[], []];
    etatCh.lignes = [];

    const resultat = await retrouverIdentifiantClic({ siteId: 7, utilisateur: "u-2", conversionAt: CONVERSION });

    expect(resultat.identifiant).toBeNull();
    expect(resultat.clics).toEqual([]);
  });

  it("laisse remonter une panne de base — un silence ferait perdre des conversions", async () => {
    etatDb.resultats = [[]];
    etatCh.erreur = new Error("ClickHouse indisponible");

    await expect(
      retrouverIdentifiantClic({ siteId: 7, utilisateur: "u-1", conversionAt: CONVERSION }),
    ).rejects.toThrow("ClickHouse indisponible");
  });

  it("transmet la stratégie premier-clic jusqu'au SQL et au choix", async () => {
    etatDb.resultats = [[]];
    etatCh.lignes = [
      ligne({ horodatage: "2026-08-26T09:00:00Z", gclid: "recent" }),
      ligne({ horodatage: "2026-08-20T09:00:00Z", gclid: "premier" }),
    ];

    const resultat = await retrouverIdentifiantClic({
      siteId: 7,
      utilisateur: "u-1",
      conversionAt: CONVERSION,
      strategie: "premier",
    });

    expect(etatCh.specs[0].query).toContain("ORDER BY timestamp ASC");
    expect(resultat.identifiant!.valeur).toBe("premier");
  });
});
