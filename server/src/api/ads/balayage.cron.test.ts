/**
 * Le garde de cluster du balayage planifié, isolé dans son propre fichier —
 * même raison que `outbox.cron.test.ts` : simuler `node:cluster` contaminerait
 * tout le reste d'un fichier de tests, puisque `db/postgres/postgres.ts`
 * l'importe pour dimensionner son pool.
 *
 * Ce que ça protège : `CLUSTER_WORKERS` vaut 4 en production. Sans le garde,
 * quatre processus balaient les mêmes événements toutes les cinq minutes. Rien ne
 * serait compté deux fois — la clé d'unicité du journal tient — mais on paierait
 * quatre fois les requêtes ClickHouse, qui sont la partie chère, **et rien ne le
 * signalerait**. Pas d'erreur, pas d'alerte : juste une facture et des journaux
 * illisibles.
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

/** `node-cron` simulé : on veut savoir SI une tâche est planifiée, pas attendre l'heure. */
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
 * Le balayage sans dépendances explicites parle à la base par défaut. On la
 * remplace par un compteur pilotable : ce fichier n'a aucune raison de démarrer
 * un Postgres, et le point à démontrer est le COMPORTEMENT DU PASSAGE.
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

/** `settings.js` est importé par `outbox.js` et parle à la vraie base. */
vi.mock("./settings.js", () => ({ lireReglages: async () => null }));

const { CADENCE_BALAYAGE, adsScanService } = await import("./balayage.js");

beforeEach(() => {
  etatCron.planifiees = [];
  etatCron.rappels = [];
  etatCron.arrets = 0;
  etatBase.appels = 0;
  etatBase.reponse = null;
  etatCluster.isWorker = false;
});

afterEach(() => {
  adsScanService.stopAdsScanCron();
});

describe("garde de cluster", () => {
  it("planifie le balayage sur le processus primaire", () => {
    adsScanService.startAdsScanCron();
    expect(etatCron.planifiees).toEqual([CADENCE_BALAYAGE]);
  });

  it("ne planifie RIEN sur un worker de cluster", () => {
    etatCluster.isWorker = true;
    adsScanService.startAdsScanCron();
    expect(etatCron.planifiees).toEqual([]);
  });

  it("la cadence est plus lâche que celle du drain : une passe interroge ClickHouse", () => {
    expect(CADENCE_BALAYAGE).toBe("*/5 * * * *");
  });
});

describe("le passage planifié", () => {
  it("saute un passage si le précédent n'est pas terminé", async () => {
    let debloquer: (() => void) | null = null;
    etatBase.reponse = () =>
      new Promise(resolve => {
        debloquer = () => resolve({ rows: [] });
      });

    adsScanService.startAdsScanCron();
    const premier = etatCron.rappels[0]();
    // Le second part alors que le premier attend encore la base.
    await etatCron.rappels[0]();
    expect(etatBase.appels).toBe(1);

    debloquer!();
    await premier;
  });

  it("une erreur de passage ne remonte pas : le cron continuerait sinon à s'arrêter", async () => {
    etatBase.reponse = async () => {
      throw new Error("base indisponible");
    };
    adsScanService.startAdsScanCron();
    await expect(etatCron.rappels[0]()).resolves.toBeUndefined();
  });

  it("un passage en échec ne bloque pas le suivant", async () => {
    etatBase.reponse = async () => {
      throw new Error("base indisponible");
    };
    adsScanService.startAdsScanCron();
    await etatCron.rappels[0]();
    await etatCron.rappels[0]();
    expect(etatBase.appels).toBe(2);
  });

  it("l'arrêt libère la tâche", () => {
    adsScanService.startAdsScanCron();
    adsScanService.stopAdsScanCron();
    expect(etatCron.arrets).toBe(1);
  });
});
