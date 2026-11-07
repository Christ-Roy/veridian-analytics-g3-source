import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Ce fichier a été ENTIÈREMENT COMMENTÉ pendant un temps, ce qui revenait à ne
// pas avoir de lint du tout sur le client : `npm run lint` inspectait zéro
// fichier et sortait en 0. Il est rétabli. Ne pas le recommenter pour faire
// passer une étape de CI — un vert sur zéro fichier inspecté ne mesure rien.

const eslintConfig = [
  {
    // Portée globale. Un `ignores` posé à côté de `rules` ne filtrerait que
    // cet objet de configuration ; seul un objet qui ne contient QUE `ignores`
    // exclut réellement ces chemins de l'analyse.
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "public/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Le dépôt type largement en `any` sur les frontières d'API et les
      // bibliothèques de graphes. En faire une erreur reviendrait à réécrire
      // le typage du fork ; c'est un chantier en soi, pas un préalable au lint.
      "@typescript-eslint/no-explicit-any": "off",

      // ─── Règles du compilateur React, ramenées d'ERREUR à AVERTISSEMENT ───
      //
      // Elles viennent d'eslint-plugin-react-hooks v6, qu'eslint-config-next 16
      // active en erreur par défaut. Elles ne décrivent PAS des bugs : elles
      // disent pourquoi le compilateur React renoncerait à optimiser un
      // composant. Or le compilateur n'est PAS activé ici — `next.config.ts`
      // ne pose aucun `reactCompiler`, et `babel-plugin-react-compiler` n'est
      // pas une dépendance du projet. Elles mesurent donc quelque chose qui ne
      // tourne pas.
      //
      // Elles restent AFFICHÉES, et leur nombre est suivi : c'est de la dette
      // visible, pas un sujet clos. Ce qui est refusé, c'est qu'un
      // `Math.random()` dans la largeur d'un squelette de chargement bloque la
      // CI au même titre qu'un hook appelé conditionnellement.
      //
      // 🔴 Ce qui n'est PAS assoupli, et ne doit jamais l'être :
      //   - `react-hooks/rules-of-hooks` : un hook derrière une condition
      //     change l'ordre des hooks entre deux rendus. React lève alors
      //     « Rendered fewer hooks than expected » et l'écran tombe. C'est
      //     exactement le bug qui dormait dans la page Replay.
      //   - `react-hooks/refs` : un ref lu ou écrit pendant le rendu ne
      //     déclenche aucun re-rendu ; l'écran reste sur une valeur périmée.
      //   - `react-hooks/use-memo`, `react-hooks/immutability` : listes de
      //     dépendances et écritures qui cassent à l'exécution.
      // Ces quatre-là restent en erreur, à leur sévérité d'origine.
      //
      // Pour revenir en arrière : activer le compilateur React dans
      // `next.config.ts`, puis remonter ces quatre lignes en "error" et
      // résorber ce que le compteur affiche.
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
];

export default eslintConfig;
