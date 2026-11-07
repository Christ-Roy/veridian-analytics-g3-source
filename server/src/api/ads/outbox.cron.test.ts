/**
 * Le garde de cluster du drain planifié, isolé dans son propre fichier.
 *
 * Pourquoi à part : prouver le garde demande de simuler `node:cluster`, et ce
 * module est importé par `db/postgres/postgres.ts` pour dimensionner son pool.
 * Le simuler dans `outbox.test.ts` contaminerait tout le reste du fichier.
 *
 * Ce que ça protège : `CLUSTER_WORKERS` vaut 4 en production. Sans ce garde,
 * quatre processus drainent la même file. Le bail de `reclamerLot` et la
 * déduplication de Google empêcheraient bien le doublon de conversion, mais on
 * paierait quatre fois les requêtes et les jetons OAuth, et les journaux
 * deviendraient illisibles. Surtout : **rien ne le signalerait**. Pas d'erreur,
 * pas d'alerte, juste une charge inutile que personne ne remarque.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const etatCluster = vi.hoisted(() => ({ isWorker: false }));
vi.mock("node:cluster", () => ({
  default: {
    get isWorker() {
      return etatCluster.isWorker;
    },
    get isPrimary() {
      return !etatCluster.isWorker;
    },
  },
}));

/**
 * `node-cron` est simulé : on veut savoir SI une tâche est planifiée, pas
 * attendre l'heure. Le rappel est CONSERVÉ, parce que c'est lui qui porte les
 * deux gardes du passage (chevauchement, reprise après panne) — le déclencher à
 * la main est le seul moyen de les observer.
 */
const etatCron = vi.hoisted(() => ({
  planifiees: [] as string[],
  rappels: [] as (() => Promise<void>)[],
  arrets: 0,
}));
vi.mock("node-cron", () => ({
  schedule: (expression: string, rappel: () => Promise<void>) => {
    etatCron.planifiees.push(expression);
    etatCron.rappels.push(rappel);
    return { stop: () => void etatCron.arrets++ } as unknown;
  },
}));

/**
 * Le drain sans dépendances explicites parle à la base par défaut. On la
 * remplace par un compteur pilotable : ce fichier n'a aucune raison de démarrer
 * un Postgres, et le point à démontrer est le COMPORTEMENT DU PASSAGE, pas ce
 * que la requête rapporte.
 */
const etatBase = vi.hoisted(() => ({
  appels: 0,
  reponse: null as null | (() => Promise<unknown>),
}));
vi.mock("../../db/postgres/postgres.js", () => ({
  db: {
    execute: async () => {
      etatBase.appels += 1;
      return etatBase.reponse ? etatBase.reponse() : { rows: [] };
    },
  },
}));

/**
 * Le drain consulte les réglages du site par `lireReglages`, qui interroge la
 * base avec le constructeur de requêtes de drizzle et non `execute` : le faux
 * `db` ci-dessus ne saurait pas le servir. On le remplace donc directement, en
 * rendant « site jamais configuré » — la ligne réclamée est alors écartée, ce
 * qui suffit pour observer un passage qui a EU du travail à faire.
 */
vi.mock("./settings.js", () => ({ lireReglages: async () => null }));

const { CADENCE_DRAIN, adsOutboxService } = await import("./outbox.js");

beforeEach(() => {
  etatCron.planifiees = [];
  etatCron.rappels = [];
  etatCron.arrets = 0;
  etatCluster.isWorker = false;
  etatBase.appels = 0;
  etatBase.reponse = null;
});

afterEach(() => {
  adsOutboxService.stopAdsDrainCron();
});

describe("adsOutboxService — le drain ne tourne qu'une fois", () => {
  it("planifie le drain sur le processus principal", () => {
    adsOutboxService.startAdsDrainCron();
    expect(etatCron.planifiees).toEqual([CADENCE_DRAIN]);
  });

  it("🔴 ne planifie RIEN sur un worker de cluster", () => {
    // Retirer le garde `if (cluster.isWorker) return` fait rougir ici, et
    // seulement ici : c'est le seul endroit du dépôt qui constate la charge x4.
    etatCluster.isWorker = true;
    adsOutboxService.startAdsDrainCron();
    expect(etatCron.planifiees).toEqual([]);
  });

  it("s'arrête proprement, et un arrêt sans démarrage ne casse rien", () => {
    adsOutboxService.startAdsDrainCron();
    adsOutboxService.stopAdsDrainCron();
    expect(etatCron.arrets).toBe(1);

    adsOutboxService.stopAdsDrainCron();
    expect(etatCron.arrets).toBe(1);
  });
});

/**
 * Le corps du passage planifié. Deux gardes y vivent, et aucun des deux ne
 * produirait la moindre trace s'il disparaissait — c'est ce qui les rend
 * dangereux et ce qui justifie de déclencher le rappel à la main.
 */
describe("adsOutboxService — le corps d'un passage de drain", () => {
  /** Le rappel que le cron aurait exécuté à l'heure dite. */
  function passage() {
    adsOutboxService.startAdsDrainCron();
    const rappel = etatCron.rappels.at(-1);
    expect(rappel, "aucun rappel planifié").toBeTypeOf("function");
    return rappel!;
  }

  it("ne lance pas un second passage tant que le premier n'est pas fini", async () => {
    // Ce qui casserait en production : la cadence est courte et un drain qui
    // attend Google peut durer. Sans ce garde, les passages s'empilent, chacun
    // réclamant un lot et consommant un jeton OAuth. Le bail de `reclamerLot`
    // évite bien le doublon de conversion, donc RIEN ne signalerait l'empilement
    // — seulement une charge et une facture qui montent.
    let debloquer: () => void = () => {};
    const enAttente = new Promise<void>(res => (debloquer = res));
    etatBase.reponse = async () => {
      await enAttente;
      return { rows: [] };
    };

    const rappel = passage();
    const premier = rappel(); // volontairement pas attendu : il est encore en vol
    await rappel(); // le second doit rendre la main immédiatement

    expect(etatBase.appels).toBe(1);
    debloquer();
    await premier;
    expect(etatBase.appels).toBe(1);
  });

  it("🔴 une panne pendant un passage n'arrête pas le drain pour de bon", async () => {
    // LE test de ce fichier. Le `finally` qui remet `enCours` à false n'a l'air
    // de rien ; sans lui, la PREMIÈRE erreur venue fige le drapeau à true et
    // plus AUCUN passage ne repart, pour toute la durée de vie du processus.
    // Les conversions s'accumulent alors en `pending` sans qu'aucune erreur ne
    // soit levée, aucune alerte ne parte : l'envoi vers Google s'arrête en
    // silence et ne se découvre qu'en constatant un chiffre d'affaires manquant
    // dans l'interface Ads, des jours plus tard.
    const rappel = passage();

    etatBase.reponse = async () => {
      throw new Error("connexion à la base perdue pendant le drain");
    };
    // Le rappel ne doit pas rejeter : une promesse rejetée dans un cron n'a
    // personne pour l'attraper et tue le processus sous `--unhandled-rejections`.
    await expect(rappel()).resolves.toBeUndefined();
    expect(etatBase.appels).toBe(1);

    etatBase.reponse = null;
    await rappel();
    expect(etatBase.appels, "le passage suivant doit repartir").toBe(2);
  });

  it("un passage qui a du travail va jusqu'au bout, il ne se contente pas de réclamer", async () => {
    // Sans ce test, tout ce que ce fichier prouve du rappel planifié est qu'il
    // appelle quelque chose qui ne trouve rien. Ici la file contient une ligne :
    // le passage doit la réclamer PUIS statuer dessus. Un drain qui s'arrêterait
    // après la réclamation laisserait la conversion en `pending` avec son bail
    // posé et son compteur d'essais incrémenté — c'est-à-dire qu'il la
    // consommerait sans jamais l'envoyer, jusqu'à épuisement du budget.
    const ligne = {
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
    };
    // La réclamation rend la ligne, la suite (le marquage) ne rend rien.
    const file: unknown[] = [{ rows: [ligne] }];
    etatBase.reponse = async () => file.shift() ?? { rows: [] };

    await passage()();

    // Deux requêtes : réclamer, puis statuer. Une seule voudrait dire que la
    // ligne est restée en l'air.
    expect(etatBase.appels).toBe(2);
  });

  it("drainMaintenant transmet ses dépendances au lieu de les ignorer", async () => {
    // Ce point d'entrée sert aux diagnostics, et un diagnostic se fait avec une
    // base de recette ou `validateOnly`. S'il laissait tomber les dépendances
    // qu'on lui passe, la vérification partirait sur la base de PRODUCTION et
    // enverrait de vraies conversions à Google — un test qui écrit chez le
    // client, ce qui ne se reprend pas.
    const injectee = { execute: vi.fn(async () => ({ rows: [] })) };
    const bilan = await adsOutboxService.drainMaintenant({ base: injectee, limite: 5 });

    expect(injectee.execute).toHaveBeenCalledTimes(1);
    expect(etatBase.appels, "la base par défaut ne doit pas être touchée").toBe(0);
    expect(bilan.reclamees).toBe(0);
  });
});
