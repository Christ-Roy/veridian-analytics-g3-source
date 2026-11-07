/**
 * Ce que ce fichier protège : **ce que voit un appelant quand ça casse**, et le
 * **câblage** des sept routes sur leur chaîne d'autorisation.
 *
 * `routes.test.ts` couvre le parcours nominal et la garde, contre une vraie
 * base. Il ne peut pas couvrir ces deux-là, et pour deux raisons différentes :
 *
 *  1. **Les chemins d'erreur.** Faire tomber une vraie PGlite au bon moment
 *     n'est ni reproductible ni lisible. Ici la couche de réglages est simulée
 *     et lève à volonté — c'est le SEUL moyen d'observer les cinq `catch`.
 *     L'enjeu n'est pas le code 500, c'est ce que le corps de la réponse
 *     contient : un message d'erreur Postgres nomme la requête, les colonnes et
 *     parfois la valeur qui a fâché. Sans le `catch`, Fastify rend son 500 par
 *     défaut, dont le champ `message` porte le texte de l'exception — donc les
 *     internes de la base, à un appelant qui n'a que le droit de lire des
 *     réglages.
 *
 *  2. **Le montage.** `routes.test.ts` appelle les handlers directement : il ne
 *     voit RIEN de la table de routage. Poser la route d'écriture des réglages
 *     sur la chaîne de lecture serait donc invisible, et c'est précisément
 *     l'erreur qui coûte le plus cher ici — n'importe quel membre du site
 *     pourrait rediriger les conversions d'un client vers un autre compte
 *     Google Ads, c'est-à-dire vers l'argent de quelqu'un d'autre. Aucun test
 *     de ce dépôt ne regardait ce câblage avant celui-ci.
 *
 * La couche de réglages et le code d'accès sont simulés : ce fichier ne
 * démontre ni l'un ni l'autre (`settings.test.ts` et `routes.test.ts` s'en
 * chargent, contre une vraie base), il démontre la conduite des handlers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Un message d'exception réaliste : ce que Postgres écrit vraiment, requête
 * comprise. C'est lui qu'on traque dans les réponses.
 */
const FUITE =
  'relation "ads_site_settings" does not exist — SELECT customer_id, enabled FROM ads_site_settings WHERE site_id = 42';

const etat = vi.hoisted(() => ({ leve: true }));

/** Chaque fonction de réglages lève, ou rend une valeur inerte selon `etat.leve`. */
vi.mock("./settings.js", () => {
  const casse = async () => {
    if (etat.leve) throw new Error(FUITE);
    return null as any;
  };
  return {
    lireReglages: vi.fn(casse),
    enregistrerReglages: vi.fn(casse),
    listerCorrespondances: vi.fn(casse),
    creerCorrespondance: vi.fn(casse),
    supprimerCorrespondance: vi.fn(casse),
    etatSante: vi.fn(casse),
  };
});

// La garde est démontrée ailleurs, contre une vraie base. Ici elle laisse
// passer : ce qu'on veut observer est ce qui se produit APRÈS elle.
vi.mock("../../lib/auth-utils.js", () => ({
  getUserHasAccessToSite: vi.fn(async () => true),
  getUserHasAdminAccessToSite: vi.fn(async () => true),
}));

import { supprimerCorrespondance } from "./settings.js";
import {
  createAdsMapping,
  creerRoutesAds,
  deleteAdsMapping,
  getAdsCouts,
  getAdsHealth,
  getAdsSettings,
  listAdsMappings,
  updateAdsSettings,
} from "./routes.js";

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

function requestStub(params: Record<string, string>, body?: unknown) {
  const journal: unknown[][] = [];
  return {
    requete: {
      user: { id: "u" },
      headers: {},
      params,
      body,
      log: { error: (...args: unknown[]) => void journal.push(args) },
    } as any,
    journal,
  };
}

/** Les six handlers, avec les paramètres minimaux pour atteindre leur `catch`. */
const HANDLERS: [string, (req: any, res: any) => Promise<unknown>, Record<string, string>, unknown][] = [
  ["getAdsSettings", getAdsSettings as any, { siteId: "1" }, undefined],
  ["updateAdsSettings", updateAdsSettings as any, { siteId: "1" }, { enabled: true }],
  ["listAdsMappings", listAdsMappings as any, { siteId: "1" }, undefined],
  ["createAdsMapping", createAdsMapping as any, { siteId: "1" }, { eventName: "x", conversionActionId: "1" }],
  ["deleteAdsMapping", deleteAdsMapping as any, { siteId: "1", mappingId: "7" }, undefined],
  ["getAdsHealth", getAdsHealth as any, { siteId: "1" }, undefined],
];

beforeEach(() => {
  etat.leve = true;
  vi.clearAllMocks();
});

describe("routes Ads — une panne interne ne se raconte pas au client", () => {
  it.each(HANDLERS)("%s rend 500 sans rien dire de la base", async (_nom, handler, params, body) => {
    const { requete } = requestStub(params as any, body);
    const reply = replyStub();

    // Ne doit pas rejeter : un handler qui laisse filer son exception donnerait
    // le 500 par défaut de Fastify, dont le corps porte le message d'origine.
    await expect((handler as any)(requete, reply)).resolves.toBeDefined();

    expect(reply.statusCode).toBe(500);
    expect(Object.keys(reply.body)).toEqual(["error"]);

    // 🔴 Le point du test. Le corps ne doit contenir ni le message de
    // l'exception, ni le nom d'une table, ni un fragment de requête.
    const rendu = JSON.stringify(reply.body);
    expect(rendu).not.toContain(FUITE);
    expect(rendu).not.toMatch(/SELECT|INSERT|UPDATE|DELETE FROM|relation |ads_site_settings|site_id/i);
  });

  it.each(HANDLERS)("%s laisse une trace exploitable côté serveur", async (_nom, handler, params, body) => {
    // Sans journal, un 500 générique est indiagnosticable : le client ne sait
    // rien et l'exploitant non plus. Le message générique n'est acceptable que
    // parce que le vrai est écrit ici.
    const { requete, journal } = requestStub(params as any, body);
    await (handler as any)(requete, replyStub());

    expect(journal).toHaveLength(1);
    expect((journal[0][0] as Error).message).toBe(FUITE);
  });
});

describe("routes Ads — l'identifiant de correspondance est contrôlé avant la base", () => {
  it.each([["pas-un-nombre"], ["0"], ["-3"], ["1.5"], [""]])(
    "refuse « %s » en 400, sans lancer de requête",
    async valeur => {
      etat.leve = false;
      const { requete } = requestStub({ siteId: "1", mappingId: valeur });
      const reply = replyStub();
      await deleteAdsMapping(requete, reply);

      expect(reply.statusCode).toBe(400);
      // 🔴 Ce qui compte n'est pas le code, c'est que rien ne parte : sans ce
      // contrôle, `Number("pas-un-nombre")` vaut NaN et la suppression est
      // tentée avec NaN en paramètre. Postgres refuse, donc l'appelant reçoit
      // un 500 illisible là où sa saisie était simplement fausse.
      expect(supprimerCorrespondance).not.toHaveBeenCalled();
    }
  );
});

describe("routes Ads — le montage des sept routes", () => {
  /** Enregistre les appels de `fastify.<verbe>(chemin, options, handler)`. */
  function faussFastify() {
    const routes: { verbe: string; chemin: string; chaine: unknown; handler: unknown }[] = [];
    const noter = (verbe: string) => (chemin: string, chaine: unknown, handler: unknown) =>
      void routes.push({ verbe, chemin, chaine, handler });
    return {
      routes,
      instance: { get: noter("GET"), put: noter("PUT"), post: noter("POST"), delete: noter("DELETE") } as any,
    };
  }

  const chaines = {
    lecture: { preHandler: Symbol("authSiteScoped(ads, read)") },
    ecriture: { preHandler: Symbol("adminSiteScoped(ads, write)") },
  };

  async function monter() {
    const { routes, instance } = faussFastify();
    await creerRoutesAds(chaines)(instance);
    return routes;
  }

  it("expose exactement les sept routes attendues, sur le bon handler", async () => {
    const routes = await monter();
    expect(routes.map(r => `${r.verbe} ${r.chemin}`)).toEqual([
      "GET /sites/:siteId/ads/settings",
      "PUT /sites/:siteId/ads/settings",
      "GET /sites/:siteId/ads/mappings",
      "POST /sites/:siteId/ads/mappings",
      "DELETE /sites/:siteId/ads/mappings/:mappingId",
      "GET /sites/:siteId/ads/health",
      "GET /sites/:siteId/ads/couts",
    ]);
    expect(routes.map(r => r.handler)).toEqual([
      getAdsSettings,
      updateAdsSettings,
      listAdsMappings,
      createAdsMapping,
      deleteAdsMapping,
      getAdsHealth,
      getAdsCouts,
    ]);
  });

  it("🔴 monte TOUTE route qui écrit sur la chaîne d'administration", async () => {
    // Écrit comme une RÈGLE et pas comme une liste : une septième route ajoutée
    // demain sur la mauvaise chaîne rougit ici sans que personne n'ait à penser
    // à mettre ce test à jour.
    //
    // Ce qui casserait en production sans ce test : `chaines.ecriture` remplacé
    // par `chaines.lecture` sur le PUT des réglages. Aucune erreur, aucun test
    // rouge ailleurs — simplement, n'importe quel membre du site peut changer
    // le compte Google Ads de destination. Les conversions d'un client partent
    // alors chez un autre annonceur, ce qui ne se voit ni dans l'analytics, ni
    // dans le journal, et se paie en enchères faussées des deux côtés.
    for (const route of await monter()) {
      const attendue = route.verbe === "GET" ? chaines.lecture : chaines.ecriture;
      expect(route.chaine, `${route.verbe} ${route.chemin}`).toBe(attendue);
    }
  });

  it("passe les chaînes telles quelles, sans en fabriquer une au passage", async () => {
    // Le fichier reçoit ses chaînes plutôt que de les importer, pour rester
    // enregistrable ailleurs. Une chaîne recopiée ou complétée ici, et les
    // gardes d'`index.ts` ne seraient plus les seules à faire foi.
    const vues = new Set((await monter()).map(r => r.chaine));
    expect(vues).toEqual(new Set([chaines.lecture, chaines.ecriture]));
  });
});
