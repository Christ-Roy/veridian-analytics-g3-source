/**
 * Le barrel du module.
 *
 * 🔴 Pourquoi ce fichier existe, et pourquoi il ne se contente pas d'importer
 * `index.ts` pour faire monter un pourcentage.
 *
 * `index.ts` dit de lui-même sa règle de vie : « chaque lot ajoute SA ligne ici
 * et ne touche pas celles des autres ». C'est le seul fichier partagé par des
 * agents qui écrivent le dossier en parallèle, donc le seul endroit où l'oubli
 * est probable — et il est INVISIBLE :
 *
 *  - TypeScript attrape bien une ligne qui pointe vers un fichier disparu
 *    (`export * from "./parti.js"` ne compile pas), donc ce sens-là est déjà
 *    couvert et n'a pas besoin de test ;
 *  - il n'attrape RIEN dans l'autre sens. Un module ajouté au dossier sans sa
 *    ligne d'export compile, passe les tests, et n'est simplement pas exposé.
 *    Personne ne s'en aperçoit tant qu'un appelant n'essaie pas d'importer
 *    depuis le barrel — c'est-à-dire potentiellement jamais avant la production.
 *
 * C'est ce second sens que ce fichier surveille. Il lit le DOSSIER, pas une
 * liste écrite à la main : un test qui recopierait les noms de modules devrait
 * être mis à jour par le lot suivant, donc serait oublié en même temps que la
 * ligne qu'il est censé protéger.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Importer le barrel charge tout le module, donc la connexion à la base. On la
// remplace : ce fichier regarde une SURFACE D'EXPORT, il n'a rien à demander à
// Postgres et n'a aucune raison d'attendre un socket.
vi.mock("../../db/postgres/postgres.js", () => ({
  db: { execute: async () => ({ rows: [] }) },
  sql: {},
}));

// 🔴 L'import du barrel est au NIVEAU MODULE, et il doit y rester.
//
// Il y était auparavant DANS le `it`, ce qui faisait entrer la transpilation de
// tout le graphe du module Ads dans le chronomètre du test. Le test ne mesurait
// donc plus la surface d'export, il mesurait la vitesse de la machine : 15,8 s
// mesurées ici le 31/08/2026 pour trois `toHaveProperty`, d'où le `}, 60_000)`
// posé à la main — un délai qui a déjà été crevé ailleurs. Hissé ici, le coût de
// transpilation est payé à la COLLECTE, qui n'a pas de budget de temps, et le
// test redevient une assertion sur des symboles déjà résolus (mesuré à 1 ms).
//
// Ce reste bien une résolution À L'EXÉCUTION : `barrel` est le namespace
// réellement exporté par `index.ts`, pas une lecture de son texte. C'est la
// raison d'être du troisième `it` ; les deux autres couvrent déjà le texte.
// `vi.mock` est remonté par vitest au-dessus des imports, la base reste donc
// bien remplacée.
import * as barrel from "./index.js";

const dossier = import.meta.dirname;
const source = readFileSync(join(dossier, "index.ts"), "utf8");

/** Les modules du dossier : ni les tests, ni le barrel lui-même. */
const modules = readdirSync(dossier)
  .filter(f => f.endsWith(".ts") && !f.includes(".test.") && f !== "index.ts")
  .map(f => f.replace(/\.ts$/, ""))
  .sort();

describe("le barrel du module Ads", () => {
  it("connaît des modules à exposer (le filtre ne s'est pas mis à tout écarter)", () => {
    // Contrôle du contrôle : si le filtre ci-dessus cessait de trouver quoi que
    // ce soit, le test suivant passerait sur une liste vide — vert, et aveugle.
    expect(modules.length).toBeGreaterThanOrEqual(5);
    expect(modules).toContain("routes");
    expect(modules).toContain("outbox");
  });

  it("🔴 réexporte CHAQUE module du dossier", () => {
    const exportes = [...source.matchAll(/export \* from "\.\/(.+?)\.js"/g)].map(m => m[1]).sort();
    expect(exportes, "un module du dossier n'a pas sa ligne dans index.ts").toEqual(modules);
  });

  it("expose bien les symboles que le serveur importe", () => {
    // `server/src/index.ts` importe aujourd'hui depuis les fichiers directement.
    // Le barrel doit rester une porte d'entrée équivalente, sans quoi il donne
    // une fausse impression de surface publique.
    //
    // Aucun délai explicite : ce test n'attend plus rien, il inspecte un objet
    // déjà chargé. S'il redevenait lent, ce serait le signal qu'on a remis un
    // travail dans son corps, pas une raison de lui rendre une minute.
    for (const symbole of ["creerRoutesAds", "adsOutboxService", "enregistrerConversion", "lireReglages"]) {
      expect(barrel, symbole).toHaveProperty(symbole);
    }
  });
});
