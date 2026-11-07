/**
 * Un objectif est censé être une étape d'entonnoir isolée. Ces tests exécutent
 * les DEUX chemins contre le même jeu d'événements, sur ClickHouse, et
 * comparent les nombres.
 *
 * `goalConditions.test.ts` compare déjà les deux CHAÎNES SQL produites, ce qui
 * ne dit rien de ce qu'elles comptent : les deux constructeurs assemblent la
 * condition dans des requêtes différentes (l'un dans un `COUNT(DISTINCT IF(…))`
 * à plat, l'autre dans une CTE `Step1` avec `GROUP BY`), et c'est cet
 * assemblage, pas la condition, qui pourrait diverger.
 */
import { describe, expect, it } from "vitest";
import { goals } from "../../../db/postgres/schema.js";
import { buildFunnelQuery } from "../funnels/getFunnel.js";
import { FunnelStep } from "../funnels/funnelSteps.js";
import { buildGoalsConversionsQuery, buildGoalsTotalSessionsQuery } from "./getGoals.js";
import {
  clickhouseLocalDisponible,
  EvenementTest,
  executerContreClickhouse,
  exigerMesureReelle,
  mesure,
} from "../utils/clickhouseLocal.testutil.js";

type Objectif = typeof goals.$inferSelect;

const objectif = (goalId: number, goalType: string, config: Record<string, unknown>): Objectif =>
  ({ goalId, siteId: 1, name: `objectif-${goalId}`, goalType, config, createdAt: null }) as unknown as Objectif;

const vue = (session_id: string, chemin: string, horodatage: string, user_id = session_id): EvenementTest => ({
  session_id,
  user_id,
  pathname: chemin,
  timestamp: horodatage,
  type: "pageview",
});

/** Conversions comptées par le chemin « objectif ». */
function conversionsObjectif(evenements: EvenementTest[], cible: Objectif, query: Record<string, unknown> = {}): number {
  const sql = buildGoalsConversionsQuery(query as never, 1, [cible]);
  if (sql === null) throw new Error("condition d'objectif invalide");
  const lignes = executerContreClickhouse<Record<string, number>>({ evenements, sql });
  return Number(lignes[0][`goal_${cible.goalId}_conversions`]);
}

/** Sessions comptées par le chemin « entonnoir », sur une étape unique. */
function sessionsEtape(evenements: EvenementTest[], etape: FunnelStep, query: Record<string, unknown> = {}): number {
  const lignes = executerContreClickhouse<{ step_number: number; sessions: number }>({
    evenements,
    sql: buildFunnelQuery(query as never, 1, [etape]),
    params: { siteId: 1, stepNumber: 1 },
  });
  return Number(lignes.find(ligne => ligne.step_number === 1)?.sessions);
}

// Toujours actif, hors de la suite conditionnelle : sans lui, un saut
// silencieux rendrait le MÊME vert qu'une mesure réelle.
it("annonce si la mesure réelle n'a pas eu lieu", () => {
  exigerMesureReelle("La sémantique des objectifs");
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
  console.warn(
    "[goalSemantics] `clickhouse` introuvable : l'équivalence objectif / étape d'entonnoir N'EST PAS vérifiée."
  );
}

suite("un objectif compte la même chose qu'une étape d'entonnoir isolée", () => {
  const jeu: EvenementTest[] = [
    vue("s1", "/panier", "2025-01-10 10:00:00"),
    vue("s1", "/paiement", "2025-01-10 10:02:00"),
    // Deuxième passage sur la cible : ne doit compter qu'une fois des deux côtés.
    vue("s1", "/paiement", "2025-01-10 10:05:00"),
    vue("s2", "/paiement", "2025-01-10 11:00:00"),
    vue("s3", "/panier", "2025-01-10 12:00:00"),
    {
      session_id: "s4",
      user_id: "s4",
      timestamp: "2025-01-10 13:00:00",
      type: "custom_event",
      event_name: "inscription",
      props: { offre: "premium" },
    },
    {
      session_id: "s5",
      user_id: "s5",
      timestamp: "2025-01-10 14:00:00",
      type: "custom_event",
      event_name: "inscription",
      props: { offre: "gratuit" },
    },
    {
      session_id: "s6",
      user_id: "s6",
      timestamp: "2025-01-10 15:00:00",
      type: "outbound",
      props: { url: "https://partenaire.fr/offre" },
    },
  ];

  const paires: { titre: string; cible: Objectif; etape: FunnelStep; attendu: number }[] = [
    {
      titre: "un chemin exact",
      cible: objectif(1, "path", { pathPattern: "/paiement" }),
      etape: { type: "page", value: "/paiement" },
      attendu: 2,
    },
    {
      titre: "un chemin à joker",
      cible: objectif(2, "path", { pathPattern: "/pa*" }),
      etape: { type: "page", value: "/pa*" },
      attendu: 3, // s1 et s3 par /panier, s2 par /paiement
    },
    {
      titre: "un événement personnalisé",
      cible: objectif(3, "event", { eventName: "inscription" }),
      etape: { type: "event", value: "inscription" },
      attendu: 2,
    },
    {
      titre: "un événement filtré sur une propriété",
      cible: objectif(4, "event", {
        eventName: "inscription",
        propertyFilters: [{ key: "offre", value: "premium" }],
      }),
      etape: {
        type: "event",
        value: "inscription",
        propertyFilters: [{ key: "offre", value: "premium" }],
      },
      attendu: 1,
    },
    {
      titre: "un clic sortant filtré par motif",
      cible: objectif(5, "outbound", { valuePattern: "https://partenaire.fr/*" }),
      etape: { type: "outbound", value: "https://partenaire.fr/*" },
      attendu: 1,
    },
    {
      titre: "une cible que personne n'atteint",
      cible: objectif(6, "path", { pathPattern: "/inexistant" }),
      etape: { type: "page", value: "/inexistant" },
      attendu: 0,
    },
  ];

  for (const { titre, cible, etape, attendu } of paires) {
    mesure(`compte pareil des deux côtés : ${titre}`, () => {
      const parObjectif = conversionsObjectif(jeu, cible);
      const parEntonnoir = sessionsEtape(jeu, etape);

      expect(parObjectif).toBe(attendu);
      expect(parEntonnoir).toBe(attendu);
      expect(parObjectif).toBe(parEntonnoir);
    });
  }

  mesure("les deux chemins bornent la fenêtre temporelle de la même façon", () => {
    const troisJours: EvenementTest[] = [
      vue("avant", "/paiement", "2025-01-05 10:00:00"),
      vue("dedans", "/paiement", "2025-01-10 10:00:00"),
      vue("apres", "/paiement", "2025-01-20 10:00:00"),
    ];
    const fenetre = { start_date: "2025-01-09", end_date: "2025-01-11", time_zone: "UTC" };

    expect(conversionsObjectif(troisJours, objectif(7, "path", { pathPattern: "/paiement" }), fenetre)).toBe(1);
    expect(sessionsEtape(troisJours, { type: "page", value: "/paiement" }, fenetre)).toBe(1);
  });

  mesure("comme l'entonnoir, un objectif est compté par SESSION et non par personne", () => {
    // Deux visites du même visiteur atteignant la cible : deux conversions.
    // La conséquence est l'inverse de celle de l'entonnoir — ici on SUR-compte
    // une personne qui revient, là on rate un parcours étalé — mais la cause
    // est la même : `session_id` est la seule unité du produit.
    const revenant: EvenementTest[] = [
      vue("visite-1", "/paiement", "2025-01-10 10:00:00", "meme-personne"),
      vue("visite-2", "/paiement", "2025-01-11 10:00:00", "meme-personne"),
    ];

    expect(conversionsObjectif(revenant, objectif(8, "path", { pathPattern: "/paiement" }))).toBe(2);
  });
});

suite("le dénominateur et l'unité du taux de conversion des objectifs", () => {
  const jeu: EvenementTest[] = [
    // s1 arrive par /accueil : l'étape 1 de l'entonnoir de comparaison a
    // besoin d'un événement ANTÉRIEUR à sa cible, sinon la borne d'ordre
    // stricte vide l'étape 2 et la comparaison des unités n'a plus d'objet.
    vue("s1", "/accueil", "2025-01-10 09:59:00"),
    vue("s1", "/paiement", "2025-01-10 10:00:00"),
    vue("s2", "/blog", "2025-01-10 11:00:00"),
    vue("s3", "/blog", "2025-01-10 12:00:00"),
    vue("s4", "/blog", "2025-01-10 13:00:00"),
  ];

  mesure("rapporte les conversions à TOUTES les sessions du site, pas aux sessions concernées", () => {
    const total = executerContreClickhouse<{ total_sessions: number }>({
      evenements: jeu,
      sql: buildGoalsTotalSessionsQuery({} as never, 1),
    });

    expect(Number(total[0].total_sessions)).toBe(4);
  });

  mesure("🔴 INCOHÉRENCE D'API : l'objectif rend une fraction, l'entonnoir un pourcentage", () => {
    // `getGoals` calcule `total_conversions / total_sessions` — soit 0,25 ici.
    // `getFunnel` calcule `sessions * 100.0 / first_step` — soit 25 pour la
    // même proportion. Les deux champs s'appellent `conversion_rate` et
    // sortent de la même API. Un tableau de bord qui affiche l'un et l'autre
    // avec le même formateur se trompe d'un facteur 100 sur l'un des deux.
    //
    // Le test reproduit le calcul du handler (le reste de `getGoals` exige
    // Postgres) à partir des nombres réellement rendus par ClickHouse.
    const conversions = conversionsObjectif(jeu, objectif(9, "path", { pathPattern: "/paiement" }));
    const total = Number(
      executerContreClickhouse<{ total_sessions: number }>({
        evenements: jeu,
        sql: buildGoalsTotalSessionsQuery({} as never, 1),
      })[0].total_sessions
    );

    const tauxObjectif = total > 0 ? conversions / total : 0;
    expect(tauxObjectif).toBe(0.25);

    const lignesEntonnoir = executerContreClickhouse<{ step_number: number; conversion_rate: number }>({
      evenements: jeu,
      sql: buildFunnelQuery({} as never, 1, [
        { type: "page", value: "/*" },
        { type: "page", value: "/paiement" },
      ]),
      params: { siteId: 1, stepNumber: 2 },
    });
    const tauxEntonnoir = lignesEntonnoir.find(ligne => ligne.step_number === 2)?.conversion_rate;

    expect(tauxEntonnoir).toBe(25);
    expect(tauxObjectif * 100).toBe(tauxEntonnoir);
  });

  mesure("un objectif sans conversion rend 0 et non `null`", () => {
    // Le handler des objectifs garde le calcul en JavaScript et protège la
    // division (`totalSessions > 0 ? … : 0`). L'entonnoir, lui, laissait
    // ClickHouse diviser par zéro et rendait `null` ; le fork garde désormais
    // ses deux diviseurs, si bien que les deux chemins s'accordent enfin sur
    // ce cas limite. Reste l'écart d'UNITÉ entre eux, lui non corrigé et figé
    // par le test précédent.
    const conversions = conversionsObjectif([], objectif(10, "path", { pathPattern: "/paiement" }));
    expect(conversions).toBe(0);
  });
});
