/**
 * 🔴 LE contrôle qui manquait le 2026-08-29.
 *
 * Ce jour-là, le module Ads était complet : 6 100 lignes, 218 tests, 100 % de
 * couverture, une preuve réseau contre le vrai compte Google. Chaque pièce
 * fonctionnait, isolément, et chaque pièce était prouvée.
 *
 * **Et rien ne l'appelait.** `enregistrerConversion` et
 * `retrouverIdentifiantClic` n'avaient aucun appelant hors de leurs propres
 * tests. Le drain tournait toutes les deux minutes sur une table
 * structurellement vide, et l'écran de santé affichait « configuré, activé,
 * 0 en attente, 0 envoyé » — indistinguable d'un site simplement calme.
 *
 * Aucun test unitaire ne pouvait le voir : ils prouvent tous qu'une pièce
 * fonctionne QUAND on l'appelle. La question qu'aucun ne posait est « qui
 * l'appelle ? ». C'est celle-ci.
 *
 * Le contrôle porte sur le TEXTE des sources, et c'est volontaire : un appel
 * peut exister et n'être jamais atteint (un `if` toujours faux, un service jamais
 * démarré), mais son ABSENCE, elle, est décisive et se voit ici en une seconde.
 * Les tests de bout en bout de `balayage.test.ts` couvrent l'autre moitié.
 *
 * ⚠️ Ce fichier rougit aussi quand un point d'entrée est renommé. C'est voulu :
 * renommer sans mettre à jour cette liste, c'est retirer la surveillance.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE_SRC = fileURLToPath(new URL("../..", import.meta.url));

/** Tous les fichiers `.ts` de production (les tests ne comptent pas comme appelants). */
function sourcesDeProduction(dossier = RACINE_SRC, accumulateur: string[] = []): string[] {
  for (const entree of readdirSync(dossier)) {
    if (entree === "node_modules" || entree === "dist") continue;
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) sourcesDeProduction(chemin, accumulateur);
    else if (entree.endsWith(".ts") && !entree.endsWith(".test.ts") && !entree.endsWith(".d.ts")) {
      accumulateur.push(chemin);
    }
  }
  return accumulateur;
}

/**
 * 🔴 Le texte source PRIVÉ DE SES COMMENTAIRES.
 *
 * Sans cela, ce fichier ne surveille rien. Constaté en le sabotant : commenter
 * `// adsScanService.startAdsScanCron();` laissait la suite VERTE, puisque la
 * ligne commentée contient toujours la chaîne cherchée — et qu'un `import` non
 * utilisé continue de nommer le symbole. Un contrôle qui reste vert quand on
 * débranche ce qu'il protège est pire que pas de contrôle : il rassure.
 *
 * On retire donc les commentaires de bloc et de ligne avant toute recherche. La
 * découpe est grossière (une chaîne contenant `//` serait tronquée), ce qui est
 * sans conséquence ici : on cherche des noms de symboles, pas des URL.
 *
 * ⚠️ Le commentaire de bloc n'est retiré que s'il OUVRE sa ligne. Une découpe
 * naïve sur `/*` avalait `fastify.all("/api/auth/*", …)` de `src/index.ts` et
 * tout ce qui suivait jusqu'à la fin du fichier de types — dont précisément les
 * lignes surveillées ici. Le contrôle échouait alors sur du code parfaitement
 * sain, ce qui est l'autre façon de ne rien surveiller.
 */
function sansCommentaires(texte: string): string {
  return texte
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, " ")
    .split("\n")
    .map(ligne => ligne.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

const SOURCES = sourcesDeProduction().map(chemin => ({
  chemin,
  texte: sansCommentaires(readFileSync(chemin, "utf8")),
}));

/**
 * Fichiers qui NOMMENT un symbole, hors sa propre définition et hors barrel.
 *
 * Le barrel (`api/ads/index.ts`) est exclu parce qu'il réexporte tout : y trouver
 * un nom ne prouve strictement rien sur son usage. C'est exactement le genre de
 * faux témoin qui aurait rendu ce contrôle vert le 2026-08-29.
 */
function appelants(symbole: string, fichierDeDefinition: string): string[] {
  const motif = new RegExp(`\\b${symbole}\\b`);
  return SOURCES.filter(
    ({ chemin, texte }) =>
      !chemin.endsWith(fichierDeDefinition) &&
      !chemin.endsWith("api/ads/index.ts") &&
      // 🔴 Les lignes d'`import` sont retirées avant la recherche : un import
      // qui subsiste alors que l'appel a disparu nomme encore le symbole, et
      // rendrait ce contrôle vert sur un module redevenu inerte. C'est
      // exactement ce qui s'est produit au premier sabotage de ce fichier.
      motif.test(texte.replace(/^\s*import[\s\S]*?from\s+"[^"]*";?\s*$/gm, "")),
  ).map(({ chemin }) => chemin.slice(RACINE_SRC.length));
}

/**
 * Les points d'entrée du module : ce qui n'a AUCUNE raison d'exister si personne
 * ne l'appelle. Chaque ligne est une pièce qui, laissée orpheline, produirait un
 * module silencieusement inerte.
 */
const POINTS_DENTREE: { symbole: string; definiDans: string; role: string }[] = [
  {
    symbole: "retrouverIdentifiantClic",
    definiDans: "api/ads/attribution.ts",
    role: "retrouver l'identifiant de clic d'un convertisseur",
  },
  {
    symbole: "enregistrerConversion",
    definiDans: "api/ads/outbox.ts",
    role: "inscrire une conversion au journal de sortie",
  },
  {
    symbole: "adsScanService",
    definiDans: "api/ads/balayage.ts",
    role: "le balayage planifié, qui alimente le journal",
  },
  {
    symbole: "adsOutboxService",
    definiDans: "api/ads/outbox.ts",
    role: "le drain planifié, qui vide le journal",
  },
  {
    symbole: "ingestConversions",
    definiDans: "api/ads/dataManager.ts",
    role: "l'envoi réseau vers Google",
  },
];

describe("aucun point d'entrée du module Ads n'est orphelin", () => {
  for (const { symbole, definiDans, role } of POINTS_DENTREE) {
    it(`${symbole} est appelé quelque part en production (${role})`, () => {
      const trouves = appelants(symbole, definiDans);
      expect(
        trouves,
        `« ${symbole} » n'a aucun appelant hors de ${definiDans} et de ses tests. ` +
          `Le module compile, ses tests passent, et il ne produit RIEN : c'est le défaut du 2026-08-29.`,
      ).not.toHaveLength(0);
    });
  }
});

describe("la chaîne est câblée au démarrage du serveur", () => {
  const indexServeur = SOURCES.find(({ chemin }) => chemin.endsWith("src/index.ts"))!;

  it("le serveur démarre le balayage", () => {
    // Sans cette ligne, tout le reste du module est du code mort : le drain
    // tourne sur une table que personne ne remplit.
    expect(indexServeur.texte).toContain("adsScanService.startAdsScanCron()");
  });

  it("le serveur démarre le drain", () => {
    expect(indexServeur.texte).toContain("adsOutboxService.startAdsDrainCron()");
  });

  it("les deux tâches sont sous le garde de cluster, POUR LE MODE MONO-PROCESSUS", () => {
    // Ce garde reste juste, mais il ne couvre QUE `CLUSTER_WORKERS=0`. La
    // version précédente de ce test s'arrêtait là et se croyait complète : elle
    // exigeait la présence d'un appel dans une branche qui, en mode cluster,
    // n'est jamais exécutée. Elle validait la MÉTHODE, pas la CIBLE.
    const branche = indexServeur.texte.slice(indexServeur.texte.indexOf("if (!cluster.isWorker) {\n      telemetryService"));
    const finBranche = branche.indexOf("\n    }");
    const corps = branche.slice(0, finBranche);
    expect(corps).toContain("adsScanService.startAdsScanCron()");
    expect(corps).toContain("adsOutboxService.startAdsDrainCron()");
  });

  it("le PROCESSUS PRIMAIRE les démarre aussi, sinon le module est inerte en production", () => {
    // 🔴 LE DÉFAUT QUE CE TEST EXISTE POUR ATTRAPER, constaté le 2026-09-03.
    //
    // En mode cluster, `cluster.ts` est le point d'entrée : le primaire forke
    // et n'importe JAMAIS `index.js`, et dans chaque worker `cluster.isWorker`
    // vaut true. Les deux crons, présents uniquement dans `index.ts`, n'étaient
    // donc démarrés nulle part dès que `CLUSTER_WORKERS >= 1` — c'est-à-dire
    // partout sauf en développement.
    //
    // Mesuré sur le staging : module configuré, envoi activé, une
    // correspondance, un achat avec son identifiant de clic, et
    // `scanVerdict: "never_ran"` neuf minutes plus tard. Aucune erreur nulle
    // part : l'écran affichait « activé, 0 en attente », indistinguable d'un
    // site sans trafic.
    const grappe = SOURCES.find(({ chemin }) => chemin.endsWith("src/cluster.ts"));
    expect(grappe, "src/cluster.ts doit faire partie des sources lues").toBeDefined();
    const branchePrimaire = grappe!.texte.slice(
      grappe!.texte.indexOf("} else if (cluster.isPrimary) {"),
      grappe!.texte.indexOf("for (let i = 0; i < workerCount; i++)")
    );
    expect(branchePrimaire.length, "branche primaire introuvable : le test ne mesure plus rien").toBeGreaterThan(0);
    expect(branchePrimaire).toContain("adsScanService.startAdsScanCron()");
    expect(branchePrimaire).toContain("adsOutboxService.startAdsDrainCron()");
  });
});

describe("le balayage relie bien les deux lots qu'il est censé coudre", () => {
  const balayage = SOURCES.find(({ chemin }) => chemin.endsWith("api/ads/balayage.ts"))!;

  it("il importe la VRAIE attribution et la VRAIE écriture au journal", () => {
    // Le point sensible : rien n'empêcherait le balayage de n'appeler que ses
    // dépendances injectées, donc de n'être prouvé que contre des simulacres.
    // Les valeurs par défaut sont ce qui le relie au module réel.
    expect(balayage.texte).toMatch(/import \{ retrouverIdentifiantClic \} from "\.\/attribution\.js"/);
    expect(balayage.texte).toMatch(/enregistrerConversion[\s\S]*from "\.\/outbox\.js"/);
    expect(balayage.texte).toContain("deps.attribuer ?? retrouverIdentifiantClic");
    expect(balayage.texte).toContain("deps.enregistrer ?? enregistrerConversion");
  });
});
