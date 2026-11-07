/**
 * Diagnostic de mesure : « ce que ce site envoie est-il exploitable ? »
 *
 * Module NEUTRE, volontairement hors de `api/ads/` : la majorité des sites de la
 * plateforme n'ont pas de compte publicitaire et leur mesure se diagnostique
 * quand même. La cohérence publicitaire n'est qu'une section du rapport.
 *
 *   mesure    le verdict, fonction pure, testable sans base
 *   collecte  les requêtes ClickHouse qui l'alimentent
 *   routes    la route de lecture
 */
export * from "./mesure.js";
export * from "./collecte.js";
export * from "./routes.js";
