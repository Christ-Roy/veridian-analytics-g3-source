import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    environmentMatchGlobs: [
      // Use jsdom for analytics script tests
      ["src/analytics-script/**", "jsdom"],
    ],

    // Veridian — délais relevés le 2026-08-31, après mesure sur le runner auto-hébergé.
    //
    // Le défaut de vitest est de 5 s. Une dizaine de fichiers montent une base
    // PGlite (WebAssembly) dans un `beforeAll` qui ne fait QUE la démarrer : sur
    // une machine partagée, ce démarrage dépasse la seconde de CPU disponible et
    // le fichier entier rougit sans qu'un seul test n'ait été évalué. Les rouges
    // changeaient d'une exécution à l'autre — signature d'une famine de
    // ressources, jamais d'un défaut de code.
    //
    // Mesuré, levier par levier : 12 fichiers rouges au départ, 8 en relevant le
    // CPU du conteneur, 5 en limitant les workers (vitest en ouvrait un par cœur
    // de l'HÔTE, six, alors que le conteneur n'a droit qu'à deux).
    //
    // Les deux valeurs sont volontairement DIFFÉRENTES :
    //   - hookTimeout 30 s : démarrer une base est un coût fixe d'infrastructure,
    //     il ne mesure rien de ce que le test prétend vérifier ;
    //   - testTimeout 15 s : un TEST qui dépasse quinze secondes dit probablement
    //     quelque chose de vrai. Les aligner par confort perdrait ce signal.
    //
    // ⚠️ Le prix, assumé : un délai plus généreux masque aussi un ralentissement
    // réel qui s'installerait. C'est un choix, pas un oubli. Un faux rouge érode
    // la confiance dans une suite bien plus qu'un test lent ne coûte.
    //
    // 🔴 MISE À JOUR DU 31/08/2026, plus tard le même jour. Le paragraphe
    // ci-dessus DÉCRIT LA RAISON D'ORIGINE, elle n'est plus la raison actuelle :
    // les 14 fichiers PGlite ne démarrent PLUS leur base dans un `beforeAll`.
    // Le DDL — donc les ~4,9 s de démarrage du moteur WebAssembly, mesurées —
    // a été hissé au niveau module, où il est payé pendant la collecte, qui n'a
    // pas de budget de temps. Contrôle A/B dans la même exécution, avec
    // `--hookTimeout=2000` : l'ancienne version d'un fichier meurt sur « Hook
    // timed out in 2000ms », la nouvelle passe en 109 ms. Ces hooks ne portent
    // plus que le TRUNCATE d'entre-deux-tests, quelques millisecondes.
    //
    // Les deux valeurs sont donc conservées telles quelles — on ne relève rien,
    // et il n'y a plus rien à relever — mais elles ne protègent plus les mêmes
    // fichiers. Ce qui reste sous ces délais est du travail de test réel : un
    // dépassement redevient un signal, ce qu'il avait cessé d'être. Les fait
    // rougir volontairement reste la seule façon de vérifier qu'ils servent.
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
