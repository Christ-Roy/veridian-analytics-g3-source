/**
 * Ce que l'entonnoir RÉPOND, pas la tête qu'a son SQL.
 *
 * `funnelSteps.test.ts` couvre déjà la construction des conditions d'étape :
 * la syntaxe, l'échappement, les jokers. Aucun test du dépôt n'importait
 * `buildFunnelQuery`, donc rien ne prouvait la sémantique du produit — l'ordre
 * des étapes, le périmètre, les taux, la fenêtre. Ces tests-là exécutent la
 * requête pour de vrai sur un `clickhouse local` jetable et vérifient les
 * NOMBRES rendus.
 *
 * Chacun est écrit pour rougir si le produit se trompait : sabotages vérifiés
 * (`>` en `>=` sur la borne d'ordre, jointure par `user_id` au lieu de
 * `session_id`, dénominateur de conversion pris à l'étape précédente).
 */
import { describe, expect, it } from "vitest";
import { buildFunnelQuery } from "./getFunnel.js";
import { FunnelStep } from "./funnelSteps.js";
import {
  clickhouseLocalDisponible,
  EvenementTest,
  executerContreClickhouse,
  exigerMesureReelle,
  mesure,
} from "../utils/clickhouseLocal.testutil.js";

type LigneEntonnoir = {
  step_number: number;
  step_name: string;
  sessions: number;
  conversion_rate: number | null;
  dropoff_rate: number | null;
};

const PANIER: FunnelStep = { type: "page", value: "/panier", name: "Panier" };
const LIVRAISON: FunnelStep = { type: "page", value: "/livraison", name: "Livraison" };
const PAIEMENT: FunnelStep = { type: "page", value: "/paiement", name: "Paiement" };

function analyser(
  evenements: EvenementTest[],
  steps: FunnelStep[],
  query: Parameters<typeof buildFunnelQuery>[0] = {} as Parameters<typeof buildFunnelQuery>[0]
): LigneEntonnoir[] {
  return executerContreClickhouse<LigneEntonnoir>({
    evenements,
    sql: buildFunnelQuery(query, 1, steps),
    params: { siteId: 1, stepNumber: steps.length },
  });
}

/** Raccourci : la vue de page `chemin` à l'instant `horodatage`. */
const vue = (session_id: string, chemin: string, horodatage: string, user_id = session_id): EvenementTest => ({
  session_id,
  user_id,
  pathname: chemin,
  timestamp: horodatage,
  type: "pageview",
});

const parEtape = (lignes: LigneEntonnoir[]) =>
  Object.fromEntries(lignes.map(ligne => [ligne.step_number, ligne])) as Record<number, LigneEntonnoir>;

// Un `describe.skip` silencieux serait exactement le défaut que ces tests
// traquent : du vert qui ne prouve rien. Le binaire absent est donc annoncé.
// Toujours actif, hors de la suite conditionnelle : sans lui, un saut
// silencieux rendrait le MÊME vert qu'une mesure réelle.
it("annonce si la mesure réelle n'a pas eu lieu", () => {
  exigerMesureReelle("La sémantique des entonnoirs");
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
    "[funnelSemantics] `clickhouse` introuvable : la sémantique des entonnoirs N'EST PAS vérifiée par cette exécution."
  );
}

suite("sémantique de l'entonnoir, exécutée contre ClickHouse", () => {
  describe("l'ordre des étapes est strict", () => {
    mesure("compte une session qui fait 1, puis 2, puis 3 dans l'ordre", () => {
      const lignes = analyser(
        [
          vue("ordre-ok", "/panier", "2025-01-10 10:00:00"),
          vue("ordre-ok", "/livraison", "2025-01-10 10:01:00"),
          vue("ordre-ok", "/paiement", "2025-01-10 10:02:00"),
        ],
        [PANIER, LIVRAISON, PAIEMENT]
      );

      expect(lignes.map(ligne => ligne.sessions)).toEqual([1, 1, 1]);
    });

    mesure("ne compte PAS une session qui fait l'étape 2 avant l'étape 1", () => {
      // /livraison à 10:00 puis /panier à 10:01 : l'étape 1 n'est atteinte
      // qu'à 10:01, et l'étape 2 exige un événement POSTÉRIEUR. La session
      // entre dans l'entonnoir sans jamais le franchir.
      const lignes = parEtape(
        analyser(
          [vue("a-rebours", "/livraison", "2025-01-10 10:00:00"), vue("a-rebours", "/panier", "2025-01-10 10:01:00")],
          [PANIER, LIVRAISON]
        )
      );

      expect(lignes[1].sessions).toBe(1);
      expect(lignes[2].sessions).toBe(0);
    });

    mesure("arrête à l'étape 1 une session qui saute l'étape 2 pour aller à l'étape 3", () => {
      const lignes = parEtape(
        analyser(
          [vue("saute", "/panier", "2025-01-10 10:00:00"), vue("saute", "/paiement", "2025-01-10 10:02:00")],
          [PANIER, LIVRAISON, PAIEMENT]
        )
      );

      expect(lignes[1].sessions).toBe(1);
      expect(lignes[2].sessions).toBe(0);
      // L'étape 3 dérive de l'étape 2 : une étape intermédiaire vide vide tout
      // ce qui suit, même si l'événement de l'étape 3 a bien eu lieu.
      expect(lignes[3].sessions).toBe(0);
    });

    mesure("mesure les trois cas ensemble sur un même jeu de sessions", () => {
      const lignes = parEtape(
        analyser(
          [
            vue("ordre-ok", "/panier", "2025-01-10 10:00:00"),
            vue("ordre-ok", "/livraison", "2025-01-10 10:01:00"),
            vue("ordre-ok", "/paiement", "2025-01-10 10:02:00"),
            vue("a-rebours", "/livraison", "2025-01-10 11:00:00"),
            vue("a-rebours", "/panier", "2025-01-10 11:01:00"),
            vue("saute", "/panier", "2025-01-10 12:00:00"),
            vue("saute", "/paiement", "2025-01-10 12:02:00"),
          ],
          [PANIER, LIVRAISON, PAIEMENT]
        )
      );

      expect(lignes[1].sessions).toBe(3);
      expect(lignes[2].sessions).toBe(1);
      expect(lignes[3].sessions).toBe(1);
    });

    mesure("🔴 DÉFAUT : deux étapes franchies dans la MÊME SECONDE ne convertissent pas", () => {
      // `timestamp` est un DateTime, donc précis à la seconde, et la borne
      // d'ordre est un `>` strict. Un tunnel rapide — clic sur « Payer » puis
      // arrivée sur /paiement dans la même seconde — est compté comme un
      // abandon. Ce n'est pas un choix documenté : c'est une conséquence de la
      // résolution de la colonne. Le test fige le comportement RÉEL pour qu'un
      // client ne le découvre pas à notre place.
      const lignes = parEtape(
        analyser(
          [
            vue("eclair", "/panier", "2025-01-10 10:00:00"),
            vue("eclair", "/livraison", "2025-01-10 10:00:00"),
          ],
          [PANIER, LIVRAISON]
        )
      );

      expect(lignes[1].sessions).toBe(1);
      expect(lignes[2].sessions).toBe(0);
    });
  });

  describe("le périmètre est la session, jamais la personne", () => {
    mesure("🔴 LIMITE STRUCTURANTE : deux visites du même visiteur ne composent pas un parcours", () => {
      // Même `user_id`, deux `session_id`. L'étape 1 est faite lundi, l'étape 2
      // mardi. L'entonnoir joint sur `session_id`, donc il ne verra JAMAIS
      // cette conversion.
      //
      // Conséquence commerciale, à dire au client avant qu'il ne la constate :
      // un achat réfléchi sur plusieurs jours — la très grande majorité des
      // achats à panier élevé — ne convertira jamais dans un entonnoir Rybbit.
      // Le taux affiché est un taux de conversion EN UNE SEULE VISITE.
      const lignes = parEtape(
        analyser(
          [
            vue("lundi", "/panier", "2025-01-06 10:00:00", "visiteur-unique"),
            vue("mardi", "/livraison", "2025-01-07 10:00:00", "visiteur-unique"),
          ],
          [PANIER, LIVRAISON]
        )
      );

      expect(lignes[1].sessions).toBe(1);
      expect(lignes[2].sessions).toBe(0);
    });

    mesure("compte une session une seule fois même si elle repasse par l'étape", () => {
      const lignes = parEtape(
        analyser(
          [
            vue("boucle", "/panier", "2025-01-10 10:00:00"),
            vue("boucle", "/panier", "2025-01-10 10:05:00"),
            vue("boucle", "/livraison", "2025-01-10 10:06:00"),
            vue("boucle", "/livraison", "2025-01-10 10:07:00"),
          ],
          [PANIER, LIVRAISON]
        )
      );

      expect(lignes[1].sessions).toBe(1);
      expect(lignes[2].sessions).toBe(1);
    });
  });

  describe("les taux", () => {
    const quatreEntrees = [
      vue("s1", "/panier", "2025-01-10 10:00:00"),
      vue("s1", "/livraison", "2025-01-10 10:01:00"),
      vue("s1", "/paiement", "2025-01-10 10:02:00"),
      vue("s2", "/panier", "2025-01-10 11:00:00"),
      vue("s2", "/livraison", "2025-01-10 11:01:00"),
      vue("s3", "/panier", "2025-01-10 12:00:00"),
      vue("s4", "/panier", "2025-01-10 13:00:00"),
    ];

    mesure("rapporte `conversion_rate` à l'étape 1, en POURCENTAGE", () => {
      const lignes = parEtape(analyser(quatreEntrees, [PANIER, LIVRAISON, PAIEMENT]));

      expect(lignes[1].sessions).toBe(4);
      expect(lignes[2].sessions).toBe(2);
      expect(lignes[3].sessions).toBe(1);

      expect(lignes[1].conversion_rate).toBe(100);
      expect(lignes[2].conversion_rate).toBe(50); // 2/4
      expect(lignes[3].conversion_rate).toBe(25); // 1/4 — et NON 1/2
    });

    mesure("rapporte `dropoff_rate` à l'étape PRÉCÉDENTE, et le force à 0 sur l'étape 1", () => {
      const lignes = parEtape(analyser(quatreEntrees, [PANIER, LIVRAISON, PAIEMENT]));

      expect(lignes[1].dropoff_rate).toBe(0);
      expect(lignes[2].dropoff_rate).toBe(50); // 1 - 2/4
      expect(lignes[3].dropoff_rate).toBe(50); // 1 - 1/2 — et NON 1 - 1/4
    });

    mesure("arrondit les taux à deux décimales", () => {
      const evenements: EvenementTest[] = [];
      for (let index = 0; index < 3; index += 1) {
        evenements.push(vue(`e${index}`, "/panier", `2025-01-10 10:0${index}:00`));
      }
      evenements.push(vue("e0", "/livraison", "2025-01-10 10:10:00"));

      const lignes = parEtape(analyser(evenements, [PANIER, LIVRAISON]));

      expect(lignes[2].conversion_rate).toBe(33.33); // 1/3
      expect(lignes[2].dropoff_rate).toBe(66.67);
    });

    mesure("rend 0 et non `null` quand aucune session n'atteint l'étape 1", () => {
      // Aucune session ne touche /panier : le dénominateur est 0. En amont,
      // ClickHouse calculait NaN et JSONEachRow le sérialisait en `null`,
      // alors que `FunnelResponse` déclare `conversion_rate: number` — un
      // `rate.toFixed(1)` cassait, un `rate > 50` devenait faux, et c'est
      // l'écran d'un entonnoir tout juste créé.
      //
      // Le fork garde désormais les deux diviseurs (voir la divergence
      // commentée dans getFunnel.ts). Ce test est ce qui la tient : sans lui,
      // un rebase la reperdrait sans que rien ne le signale.
      const lignes = parEtape(analyser([vue("ailleurs", "/blog", "2025-01-10 10:00:00")], [PANIER, LIVRAISON]));

      expect(lignes[1].sessions).toBe(0);
      expect(lignes[2].sessions).toBe(0);
      expect(lignes[1].conversion_rate).toBe(0);
      expect(lignes[2].conversion_rate).toBe(0);
      expect(lignes[1].dropoff_rate).toBe(0);
      expect(lignes[2].dropoff_rate).toBe(0);
    });

    mesure("rend 0 sur une étape intermédiaire vide, sans propager de `null` à l'aval", () => {
      // L'étape 1 est atteinte, l'étape 2 non : le diviseur du `dropoff_rate`
      // de l'étape 3 est alors 0 par le LEFT JOIN. C'est le second chemin vers
      // la division par zéro, distinct du précédent, et il survit à un
      // entonnoir par ailleurs bien peuplé.
      const lignes = parEtape(
        analyser(
          [vue("entre", "/panier", "2025-01-10 10:00:00"), vue("entre", "/paiement", "2025-01-10 10:02:00")],
          [PANIER, LIVRAISON, PAIEMENT]
        )
      );

      expect(lignes[1].sessions).toBe(1);
      expect(lignes[2].sessions).toBe(0);
      expect(lignes[3].sessions).toBe(0);
      expect(lignes[2].conversion_rate).toBe(0);
      expect(lignes[3].conversion_rate).toBe(0);
      expect(lignes[3].dropoff_rate).toBe(0);
    });

    mesure("rend une ligne par étape, dans l'ordre des étapes, même vides", () => {
      const lignes = analyser([vue("ailleurs", "/blog", "2025-01-10 10:00:00")], [PANIER, LIVRAISON, PAIEMENT]);

      expect(lignes.map(ligne => ligne.step_number)).toEqual([1, 2, 3]);
      expect(lignes.map(ligne => ligne.step_name)).toEqual(["Panier", "Livraison", "Paiement"]);
    });
  });

  describe("la fenêtre temporelle", () => {
    const troisJours: EvenementTest[] = [
      vue("avant", "/panier", "2025-01-05 10:00:00"),
      vue("avant", "/livraison", "2025-01-05 10:01:00"),
      vue("dedans", "/panier", "2025-01-10 10:00:00"),
      vue("dedans", "/livraison", "2025-01-10 10:01:00"),
      vue("apres", "/panier", "2025-01-20 10:00:00"),
      vue("apres", "/livraison", "2025-01-20 10:01:00"),
    ];

    mesure("borne l'entonnoir à la plage demandée", () => {
      const lignes = parEtape(
        analyser(troisJours, [PANIER, LIVRAISON], {
          start_date: "2025-01-09",
          end_date: "2025-01-11",
          time_zone: "UTC",
        } as any)
      );

      expect(lignes[1].sessions).toBe(1);
      expect(lignes[2].sessions).toBe(1);
    });

    mesure("applique bien la plage quand `time_zone` est ABSENT (le défaut d'amont est corrigé ici)", () => {
      // FEATURE_AUDIT.md décrit, sur le dépôt d'origine, une plage sans
      // `time_zone` silencieusement ignorée : l'entonnoir répondait alors sur
      // tout l'historique, en HTTP 200. Ce fork a réécrit `timeWindow.ts` :
      // l'absence de fuseau vaut UTC et la plage s'applique. Le test verrouille
      // la correction, faute de quoi une resynchronisation d'amont pourrait la
      // reperdre sans que rien ne le signale.
      const lignes = parEtape(
        analyser(troisJours, [PANIER, LIVRAISON], {
          start_date: "2025-01-09",
          end_date: "2025-01-11",
        } as any)
      );

      expect(lignes[1].sessions).toBe(1);
    });

    mesure("décale la borne avec le fuseau du site", () => {
      // 2025-01-09 22:00 UTC est déjà le 10 janvier à Paris (UTC+1). Demander
      // le 10 janvier « heure de Paris » doit donc attraper cet événement, et
      // le demander en UTC doit le rater.
      const veille: EvenementTest[] = [
        vue("bascule", "/panier", "2025-01-09 23:10:00"),
        vue("bascule", "/livraison", "2025-01-09 23:20:00"),
      ];

      const paris = parEtape(
        analyser(veille, [PANIER, LIVRAISON], {
          start_date: "2025-01-10",
          end_date: "2025-01-10",
          time_zone: "Europe/Paris",
        } as any)
      );
      const utc = parEtape(
        analyser(veille, [PANIER, LIVRAISON], {
          start_date: "2025-01-10",
          end_date: "2025-01-10",
          time_zone: "UTC",
        } as any)
      );

      expect(paris[2].sessions).toBe(1);
      expect(utc[1].sessions).toBe(0);
    });

    mesure("🔴 sans AUCUN paramètre de temps, l'entonnoir couvre tout l'historique", () => {
      // Comportement délibéré et documenté (« all-time est une requête
      // légitime »), mais c'est le mode par défaut : un appelant qui oublie ses
      // dates obtient un 200 dont les nombres ne décrivent pas la période
      // qu'il croit avoir demandée. Ce que la validation HTTP rattrape, c'est
      // une date MALFORMÉE ou dépareillée, pas une date absente.
      const lignes = parEtape(analyser(troisJours, [PANIER, LIVRAISON]));

      expect(lignes[1].sessions).toBe(3);
      expect(lignes[2].sessions).toBe(3);
    });

    mesure("ignore la plage quand le fuseau est invalide, et rend l'historique entier", () => {
      // `resolve()` dégrade en all-time sur un fuseau inutilisable. En HTTP,
      // `validateHttpTimeParams` refuse d'abord la requête ; hors HTTP (les
      // jobs de rapport), cette dégradation silencieuse subsiste.
      const lignes = parEtape(
        analyser(troisJours, [PANIER, LIVRAISON], {
          start_date: "2025-01-09",
          end_date: "2025-01-11",
          time_zone: "Mars/Olympus",
        } as any)
      );

      expect(lignes[1].sessions).toBe(3);
    });
  });

  describe("les étapes autres que les pages", () => {
    mesure("enchaîne une vue de page puis un événement personnalisé", () => {
      const lignes = parEtape(
        analyser(
          [
            vue("mixte", "/panier", "2025-01-10 10:00:00"),
            {
              session_id: "mixte",
              user_id: "mixte",
              timestamp: "2025-01-10 10:01:00",
              type: "custom_event",
              event_name: "achat",
              props: { montant: 42 },
            },
          ],
          [PANIER, { type: "event", value: "achat", name: "Achat" }]
        )
      );

      expect(lignes[2].sessions).toBe(1);
    });

    mesure("n'attrape pas un événement dont la propriété filtrée diverge", () => {
      const etape: FunnelStep = {
        type: "event",
        value: "achat",
        name: "Achat premium",
        propertyFilters: [{ key: "offre", value: "premium" }],
      };

      const lignes = parEtape(
        analyser(
          [
            vue("mixte", "/panier", "2025-01-10 10:00:00"),
            {
              session_id: "mixte",
              user_id: "mixte",
              timestamp: "2025-01-10 10:01:00",
              type: "custom_event",
              event_name: "achat",
              props: { offre: "gratuit" },
            },
          ],
          [PANIER, etape]
        )
      );

      expect(lignes[2].sessions).toBe(0);
    });

    mesure("restreint une étape au `hostname` demandé", () => {
      const lignes = parEtape(
        analyser(
          [
            { ...vue("hotes", "/panier", "2025-01-10 10:00:00"), hostname: "boutique.fr" },
            { ...vue("hotes", "/livraison", "2025-01-10 10:01:00"), hostname: "blog.fr" },
          ],
          [PANIER, { ...LIVRAISON, hostname: "boutique.fr" }]
        )
      );

      expect(lignes[1].sessions).toBe(1);
      expect(lignes[2].sessions).toBe(0);
    });
  });

  mesure("ne mélange pas deux sites", () => {
    const lignes = parEtape(
      analyser(
        [
          { ...vue("chez-nous", "/panier", "2025-01-10 10:00:00"), site_id: 1 },
          { ...vue("chez-nous", "/livraison", "2025-01-10 10:01:00"), site_id: 1 },
          { ...vue("chez-eux", "/panier", "2025-01-10 10:00:00"), site_id: 2 },
          { ...vue("chez-eux", "/livraison", "2025-01-10 10:01:00"), site_id: 2 },
        ],
        [PANIER, LIVRAISON]
      )
    );

    expect(lignes[1].sessions).toBe(1);
    expect(lignes[2].sessions).toBe(1);
  });
});
