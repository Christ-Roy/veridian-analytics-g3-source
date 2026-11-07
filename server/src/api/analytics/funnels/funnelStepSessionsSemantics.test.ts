/**
 * Le nombre affiché sur une étape et la liste qu'on obtient en cliquant dessus
 * doivent décrire les mêmes sessions.
 *
 * Ce sont deux requêtes distinctes, écrites séparément (`getFunnel.ts` et
 * `getFunnelStepSessions.ts`), qui répètent la même construction de CTE. Rien
 * n'obligeait jusqu'ici les deux à rester d'accord : un client qui voit « 40
 * sessions » et n'en obtient que 37 au clic n'a aucune raison de croire le
 * reste du produit.
 */
import { describe, expect, it } from "vitest";
import { buildFunnelQuery } from "./getFunnel.js";
import { buildFunnelStepSessionsQuery, GetFunnelStepSessionsRequest } from "./getFunnelStepSessions.js";
import { FunnelStep } from "./funnelSteps.js";
import {
  clickhouseLocalDisponible,
  EvenementTest,
  executerContreClickhouse,
  exigerMesureReelle,
  mesure,
} from "../utils/clickhouseLocal.testutil.js";

const PANIER: FunnelStep = { type: "page", value: "/panier", name: "Panier" };
const LIVRAISON: FunnelStep = { type: "page", value: "/livraison", name: "Livraison" };
const PAIEMENT: FunnelStep = { type: "page", value: "/paiement", name: "Paiement" };
const ETAPES = [PANIER, LIVRAISON, PAIEMENT];

const vue = (session_id: string, chemin: string, horodatage: string): EvenementTest => ({
  session_id,
  user_id: session_id,
  pathname: chemin,
  timestamp: horodatage,
  type: "pageview",
});

/**
 * Cinq sessions entrent, deux atteignent la livraison, une paie.
 *
 * `s5` ne touche jamais l'entonnoir, pour que la liste ne se réduise pas à
 * « toutes les sessions du site ». `s6` visite les deux premières pages À
 * REBOURS : sans elle, retirer la borne d'ordre du drill-down ne changerait
 * aucun résultat, et la suite resterait verte sur un produit cassé (sabotage
 * vérifié).
 */
const JEU: EvenementTest[] = [
  vue("s1", "/panier", "2025-01-10 10:00:00"),
  vue("s1", "/livraison", "2025-01-10 10:01:00"),
  vue("s1", "/paiement", "2025-01-10 10:02:00"),
  vue("s2", "/panier", "2025-01-10 11:00:00"),
  vue("s2", "/livraison", "2025-01-10 11:01:00"),
  vue("s3", "/panier", "2025-01-10 12:00:00"),
  vue("s4", "/panier", "2025-01-10 13:00:00"),
  vue("s5", "/blog", "2025-01-10 14:00:00"),
  vue("s6", "/livraison", "2025-01-10 15:00:00"),
  vue("s6", "/panier", "2025-01-10 15:01:00"),
];

function compteurEtape(numero: number): number {
  const lignes = executerContreClickhouse<{ step_number: number; sessions: number }>({
    evenements: JEU,
    sql: buildFunnelQuery({} as never, 1, ETAPES),
    params: { siteId: 1, stepNumber: ETAPES.length },
  });
  return Number(lignes.find(ligne => ligne.step_number === numero)?.sessions);
}

function sessionsListees(
  numero: number,
  mode: "reached" | "dropped",
  pagination: { limit?: number; page?: number } = {}
): string[] {
  const limite = pagination.limit ?? 25;
  const page = pagination.page ?? 1;
  const query = { mode } as GetFunnelStepSessionsRequest["Querystring"];

  const lignes = executerContreClickhouse<{ session_id: string }>({
    evenements: JEU,
    sql: buildFunnelStepSessionsQuery(query, 1, ETAPES, numero),
    // Reproduit exactement ce que le handler passe en paramètres.
    params: { siteId: 1, limit: limite, offset: (page - 1) * limite },
  });
  return lignes.map(ligne => ligne.session_id);
}

// Toujours actif, hors de la suite conditionnelle : sans lui, un saut
// silencieux rendrait le MÊME vert qu'une mesure réelle.
it("annonce si la mesure réelle n'a pas eu lieu", () => {
  exigerMesureReelle("Le détail des sessions par étape d'entonnoir");
});

// Chaque test lance un vrai processus `clickhouse local` : les 5 s par défaut de
// vitest ne suffisent pas quand la machine est chargée. Constaté le 29/08/2026 —
// ce fichier échouait à 5 016 ms en suite complète et passait seul. Un faux rouge
// érode la confiance dans la suite bien plus qu'un test lent ne coûte : on relâche
// donc le délai ICI, sans toucher au défaut global qui protège tout le reste.
// 30 s reste très au-dessus du besoin réel (~1 s à vide) : un test qui les dépasse
// signale une vraie anomalie, pas une machine occupée.
// 🔴 Aucun délai relevé ici, et il ne doit pas y en avoir : les tests de
// sémantique ci-dessous sont déclarés avec `mesure()`, qui exécute la requête
// ClickHouse pendant la COLLECTE et ne laisse dans le `it` que le verdict. Le
// démarrage du binaire — ~90 % du temps, et la seule part qui enfle quand la
// machine est disputée — sort donc du chronomètre du test au lieu d'être
// couvert par un `vi.setConfig({ testTimeout: 30_000 })` qui déplaçait
// simplement le seuil auquel la charge décidait du verdict. Le pourquoi
// détaillé et les mesures sont sur `mesure()` dans le testutil.

const suite = clickhouseLocalDisponible() ? describe : describe.skip;

if (!clickhouseLocalDisponible()) {
  // eslint-disable-next-line no-console
  console.warn("[funnelStepSessions] `clickhouse` introuvable : la cohérence compteur/liste N'EST PAS vérifiée.");
}

suite("le détail d'une étape concorde avec son compteur", () => {
  mesure("liste exactement les sessions que le compteur annonce, étape par étape", () => {
    for (const numero of [1, 2, 3]) {
      const listees = sessionsListees(numero, "reached");
      expect(listees.length, `étape ${numero}`).toBe(compteurEtape(numero));
    }
  });

  mesure("nomme les bonnes sessions, pas seulement le bon nombre", () => {
    expect(sessionsListees(1, "reached").sort()).toEqual(["s1", "s2", "s3", "s4", "s6"]);
    expect(sessionsListees(2, "reached").sort()).toEqual(["s1", "s2"]);
    expect(sessionsListees(3, "reached").sort()).toEqual(["s1"]);
  });

  mesure("les abandons d'une étape sont exactement ceux qu'elle perd vers la suivante", () => {
    const abandons = sessionsListees(1, "dropped");

    // s6 a bien vu /livraison, mais AVANT /panier : elle entre dans
    // l'entonnoir et l'abandonne aussitôt.
    expect(abandons.sort()).toEqual(["s3", "s4", "s6"]);
    expect(abandons.length).toBe(compteurEtape(1) - compteurEtape(2));
  });

  mesure("l'abandon de l'avant-dernière étape se recoupe avec le taux affiché", () => {
    const abandons = sessionsListees(2, "dropped");

    expect(abandons).toEqual(["s2"]);
    expect(abandons.length).toBe(compteurEtape(2) - compteurEtape(3));
  });
});

suite("la pagination du détail d'une étape", () => {
  mesure("découpe la liste sans perte ni recouvrement", () => {
    const tout = sessionsListees(1, "reached");
    const page1 = sessionsListees(1, "reached", { limit: 2, page: 1 });
    const page2 = sessionsListees(1, "reached", { limit: 2, page: 2 });
    const page3 = sessionsListees(1, "reached", { limit: 2, page: 3 });

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page3).toHaveLength(1);
    expect([...page1, ...page2, ...page3]).toEqual(tout);
  });

  mesure("rend une page vide au-delà de la fin, plutôt qu'une erreur", () => {
    expect(sessionsListees(1, "reached", { limit: 2, page: 9 })).toEqual([]);
  });

  mesure("🔴 DÉFAUT : un décalage négatif tronque la liste en silence, sans erreur", () => {
    // `getFunnelStepSessions.ts:206-207` calcule `limit: limit || 25` et
    // `offset: ((page || 1) - 1) * (limit || 25)` sans jamais borner ni valider
    // ces deux valeurs, contrairement à tous les autres endpoints paginés qui
    // passent par `getPaginationStatements`. Un `page=-1` produit donc un
    // OFFSET négatif.
    //
    // Ce que ce test mesure : ClickHouse ne refuse PAS un offset négatif, il
    // rend une page tronquée en HTTP 200. Le nombre de lignes qu'il rend
    // alors n'est pas spécifié — mesuré à 0 ici, à 1 sur un autre jeu de la
    // même forme — donc le test n'en fige pas la valeur : il fige le seul fait
    // qui compte, à savoir qu'aucune erreur ne prévient d'une liste amputée.
    let leve = false;
    let tronquee: string[] = [];
    try {
      tronquee = sessionsListees(1, "reached", { limit: 2, page: -1 });
    } catch {
      leve = true;
    }

    expect(leve).toBe(false);
    expect(tronquee.length).toBeLessThan(compteurEtape(1));
  });

  mesure("🔴 DÉFAUT : une limite à zéro rend une liste vide sur une étape qui a des sessions", () => {
    // Le garde-fou du handler est `limit || 25`, qui rattrape bien le NOMBRE 0.
    // Mais `Querystring.limit` arrive de la query string : c'est la CHAÎNE
    // `"0"`, qui est truthy. Elle traverse le `||`, devient `LIMIT 0`, et
    // l'endpoint répond 200 avec une liste vide sur une étape qui compte
    // cinq sessions.
    //
    // Ce test mesure l'aval : que le SQL rende bien une liste vide sous cette
    // valeur. Que la chaîne "0" y parvienne se lit dans le handler, il n'est
    // pas exécuté ici.
    expect(sessionsListees(1, "reached", { limit: 0 })).toEqual([]);
    expect(compteurEtape(1)).toBe(5);
  });
});
