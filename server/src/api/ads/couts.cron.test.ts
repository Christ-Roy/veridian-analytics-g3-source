/**
 * L'import des coûts est-il RÉELLEMENT planifié, et aux deux endroits ?
 *
 * 🔴 CE FICHIER EXISTE À CAUSE D'UN DÉFAUT RÉEL, pas d'une précaution. Les deux
 * crons du module (balayage, drain) vivaient derrière `if (!cluster.isWorker)`
 * dans `index.ts`. En mode cluster, `cluster.ts` est le point d'entrée : le
 * primaire forke et n'importe JAMAIS `index.js`, et dans chaque worker
 * `cluster.isWorker` vaut true. Avec `CLUSTER_WORKERS=2`, personne ne les
 * démarrait — le module entier était inerte, sans une seule erreur, et l'écran
 * affichait « activé, 0 en attente », indistinguable d'un site sans trafic.
 *
 * Le test qui devait l'attraper exigeait précisément la branche morte. Celui-ci
 * exige les DEUX emplacements, et le planificateur est injecté pour qu'on puisse
 * prouver la planification sans attendre une heure.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { CADENCE_IMPORT_COUTS, adsCoutsService } from "./couts.js";

const racineSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lire = (f: string) => readFileSync(join(racineSrc, f), "utf8");

describe("cadence", () => {
  it("est horaire et PAS sur l'heure ronde", () => {
    // Horaire et non quotidienne : un import quotidien qui échoue laisse les
    // chiffres périmés vingt-quatre heures, et rien ne le dit puisque la table
    // contient des données d'hier parfaitement plausibles.
    expect(CADENCE_IMPORT_COUTS).toMatch(/^\d+ \* \* \* \*$/);
    const minute = Number(CADENCE_IMPORT_COUTS.split(" ")[0]);
    expect(minute).toBeGreaterThan(0);
    expect(minute).not.toBe(30);
  });
});

describe("planification", () => {
  it("planifie à la cadence annoncée, en UTC", () => {
    const planifier = vi.fn().mockReturnValue({ stop: vi.fn() });
    adsCoutsService.startAdsCostCron(planifier as never);
    // Le service ne se planifie pas sur un worker de cluster ; les tests
    // tournent hors cluster, donc l'appel doit avoir lieu.
    expect(planifier).toHaveBeenCalledTimes(1);
    expect(planifier.mock.calls[0][0]).toBe(CADENCE_IMPORT_COUTS);
    expect(planifier.mock.calls[0][2]).toMatchObject({ timezone: "UTC" });
    adsCoutsService.stopAdsCostCron();
  });

  it("s'arrête vraiment quand on l'arrête", () => {
    const stop = vi.fn();
    const planifier = vi.fn().mockReturnValue({ stop });
    adsCoutsService.startAdsCostCron(planifier as never);
    adsCoutsService.stopAdsCostCron();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("le démarrage existe AUX DEUX ENDROITS", () => {
  it("dans index.ts, pour le mode mono-processus", () => {
    expect(lire("index.ts")).toContain("adsCoutsService.startAdsCostCron()");
  });

  it("dans la branche PRIMAIRE de cluster.ts, sans quoi il n'est jamais appelé", () => {
    // 🔴 LE test. En mode cluster, `index.ts` n'est chargé que par les workers,
    // où le garde `cluster.isWorker` empêche la planification. Sans cette
    // ligne-ci, l'import ne tourne nulle part.
    const grappe = lire("cluster.ts");
    const branche = grappe.slice(
      grappe.indexOf("} else if (cluster.isPrimary) {"),
      grappe.indexOf("for (let i = 0; i < workerCount; i++)")
    );
    expect(branche.length, "branche primaire introuvable : ce test ne mesure plus rien").toBeGreaterThan(0);
    expect(branche).toContain("adsCoutsService.startAdsCostCron()");
  });
});
