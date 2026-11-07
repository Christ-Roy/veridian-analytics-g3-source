/**
 * Ce que ce fichier protège.
 *
 * Un diagnostic a deux façons de rater, et l'une des deux est bien plus grave.
 * Rater un défaut coûte le défaut. Crier au loup coûte l'OUTIL : au bout de
 * trois rapports rouges sur des sites sains, plus personne ne l'ouvre, et il
 * n'est plus là le jour où il a raison. Le premier test du fichier est donc
 * celui du SILENCE — un site correctement mesuré ne doit produire aucun constat.
 *
 * Le second garde-fou est la distinction que tout le module sert :
 * « la donnée dit non » ne doit jamais se confondre avec « je n'ai pas la
 * donnée ». Deux tests l'exercent explicitement, sur le vide total et sur le
 * volume insuffisant, et vérifient qu'aucun des deux ne rend un verdict
 * rassurant.
 *
 * Aucune base ici : `diagnostiquerMesure` est PURE. Ce qui va chercher les
 * chiffres est testé dans `collecte.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  diagnostiquerMesure,
  LIMITE_NOMS_EVENEMENTS,
  SEUIL_NOMS_EVENEMENTS,
  VOLUME_MINIMAL_CONCLUANT,
  type EntreesDiagnostic,
  type StatistiquesEvenement,
} from "./mesure.js";

/* ─────────────────────────────── Fabriques ──────────────────────────────── */

/**
 * Un événement PARFAITEMENT mesuré : tout est présent, rien n'est douteux.
 * Chaque test dégrade UNE propriété à partir de là, ce qui rend la cause du
 * constat attendu lisible dans le test lui-même.
 */
function evenementSain(nom: string, total: number, extra: Partial<StatistiquesEvenement> = {}): StatistiquesEvenement {
  return {
    nom,
    total,
    sessions: Math.max(1, Math.round(total * 0.9)),
    avecValeur: total,
    valeurNonNumerique: 0,
    avecIdentifiant: total,
    avecConsentement: total,
    valeurMin: 19.9,
    valeurMax: 240,
    valeurMediane: 49.9,
    propsPresqueLongues: 0,
    propsTailleMax: 320,
    ...extra,
  };
}

/** Un événement d'étape amont : ni montant, ni identifiant. C'est NORMAL. */
function evenementEtape(nom: string, total: number): StatistiquesEvenement {
  return {
    nom,
    total,
    sessions: Math.max(1, Math.round(total * 0.8)),
    avecValeur: 0,
    valeurNonNumerique: 0,
    avecIdentifiant: 0,
    avecConsentement: 0,
    valeurMin: null,
    valeurMax: null,
    valeurMediane: null,
    propsPresqueLongues: 0,
    propsTailleMax: 180,
  };
}

/** Un site de référence : tunnel complet, mesure irréprochable, Ads configuré. */
function entreesSaines(surcharge: Partial<EntreesDiagnostic> = {}): EntreesDiagnostic {
  return {
    siteId: 42,
    periode: { debut: "2026-07-30T00:00:00.000Z", fin: "2026-08-29T00:00:00.000Z", jours: 30 },
    pagesVues: 42000,
    // Lignes totales lues à la source : pages vues + tous les événements.
    totalLignes: 48730,
    evenements: [
      evenementEtape("product_viewed", 5200),
      evenementEtape("cart_item_added", 640),
      evenementEtape("cart_viewed", 410),
      evenementEtape("checkout_started", 210),
      evenementEtape("payment_initiated", 160),
      evenementSain("order_confirmed", 120),
    ],
    nomsDistincts: 12,
    traficDatacenter: 300,
    traficRobot: 1800,
    correspondances: [{ eventName: "order_confirmed", conversionActionId: "987654321" }],
    adsActif: true,
    ...surcharge,
  };
}

/** Les codes des constats rendus, pour des assertions lisibles. */
const codes = (entrees: EntreesDiagnostic) => diagnostiquerMesure(entrees).constats.map(c => c.code);

/* ──────────────────────── 1. Le test du SILENCE ─────────────────────────── */

describe("un site correctement mesuré ne déclenche RIEN", () => {
  it("rend le verdict sain et aucun constat", () => {
    const rapport = diagnostiquerMesure(entreesSaines());

    expect(rapport.constats).toEqual([]);
    expect(rapport.verdict).toBe("sain");
    expect(rapport.resume).toContain("aucun défaut relevé");
  });

  it("ne reproche rien aux étapes amont, qui n'ont ni montant ni identifiant", () => {
    // Le piège classique : appliquer les règles de qualité à TOUS les événements.
    // `product_viewed` n'a ni valeur ni identifiant de commande, et c'est normal.
    const rapport = diagnostiquerMesure(entreesSaines());
    const nommes = rapport.constats.map(c => JSON.stringify(c.preuve));
    expect(nommes.some(p => p.includes("product_viewed"))).toBe(false);
  });

  it("reste sain sans compte publicitaire : l'information ne dégrade pas le verdict", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        adsActif: null,
        correspondances: [],
        // Sans régie derrière, le consentement publicitaire n'a aucune raison de
        // voyager : l'exiger crierait au loup sur la majorité des sites.
        evenements: [
          evenementEtape("cart_item_added", 640),
          evenementSain("order_confirmed", 120, { avecConsentement: 0 }),
        ],
      })
    );

    expect(rapport.verdict).toBe("sain");
    expect(rapport.constats.map(c => c.code)).toEqual(["ads_non_configure"]);
    expect(rapport.constats[0]!.gravite).toBe("information");
  });

  it("ne signale pas l'absence d'une étape intermédiaire que le site n'a pas", () => {
    // Achat en un clic : pas de « panier consulté ». Ce n'est pas un défaut.
    const rapport = diagnostiquerMesure(
      entreesSaines({
        evenements: [
          evenementEtape("product_viewed", 5200),
          evenementEtape("cart_item_added", 640),
          evenementSain("order_confirmed", 120),
        ],
      })
    );

    expect(rapport.verdict).toBe("sain");
    expect(rapport.constats).toEqual([]);
  });
});

/* ──────────── 2. « Pas de donnée » ne se déguise jamais en « OK » ────────── */

describe("l'absence de donnée est dite, jamais rassurée", () => {
  it("rend pas_de_donnees, pas sain, quand rien n'est arrivé", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({ pagesVues: 0, totalLignes: 0, evenements: [], nomsDistincts: 0, traficDatacenter: 0 })
    );

    expect(rapport.verdict).toBe("pas_de_donnees");
    expect(rapport.constats).toHaveLength(1);
    expect(rapport.constats[0]!.code).toBe("aucune_donnee");
    expect(rapport.constats[0]!.certitude).toBe("indetermine");
  });

  it("ne fabrique aucun faux défaut sur un site muet", () => {
    // Un site sans données n'a pas un tunnel cassé : il n'a pas de tunnel. Sans
    // cette sortie anticipée, il rendrait « rupture de tunnel », « valeur
    // absente » et « correspondance sans événement » d'un coup — trois
    // accusations pour une seule ignorance.
    const rendus = codes(
      entreesSaines({
        pagesVues: 0,
        totalLignes: 0,
        evenements: [],
        nomsDistincts: 0,
        traficDatacenter: 0,
        correspondances: [{ eventName: "order_confirmed", conversionActionId: "1" }],
      })
    );

    expect(rendus).toEqual(["aucune_donnee"]);
  });

  it("refuse de conclure sous le volume minimal, et ne rend PAS sain pour autant", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        evenements: [evenementEtape("cart_item_added", VOLUME_MINIMAL_CONCLUANT - 1)],
        correspondances: [],
        adsActif: true,
      })
    );

    const volume = rapport.constats.find(c => c.code === "volume_insuffisant");
    expect(volume).toBeDefined();
    expect(volume!.gravite).toBe("information");
    expect(volume!.certitude).toBe("indetermine");
    // Le point du lot : « rien d'alarmant » n'est pas « tout va bien ».
    expect(rapport.verdict).toBe("pas_de_donnees");
    expect(rapport.constats.some(c => c.code === "rupture_tunnel")).toBe(false);
    expect(rapport.resume).toContain("ne permet pas de conclure");
  });

  it("distingue le trafic robot inconnu du trafic robot nul", () => {
    const inconnu = diagnostiquerMesure(entreesSaines({ traficRobot: null }));
    const nul = diagnostiquerMesure(entreesSaines({ traficRobot: 0 }));

    const constat = inconnu.constats.find(c => c.code === "trafic_robot_inconnu");
    expect(constat).toBeDefined();
    expect(constat!.certitude).toBe("indetermine");
    // Une lacune de table ne fait pas basculer tout le rapport.
    expect(inconnu.verdict).toBe("sain");
    expect(nul.constats).toEqual([]);
  });
});

/* ─────────────────────────── 3. Le tunnel rompu ─────────────────────────── */

describe("les ruptures du tunnel", () => {
  it("dit « 640 ajouts au panier, aucune commande », pas « 0 commande »", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        evenements: [evenementEtape("product_viewed", 5200), evenementEtape("cart_item_added", 640)],
        correspondances: [],
        adsActif: true,
      })
    );

    const rupture = rapport.constats.find(c => c.code === "rupture_tunnel");
    expect(rupture).toBeDefined();
    expect(rupture!.gravite).toBe("critique");
    expect(rupture!.certitude).toBe("mesure");
    // Le chiffre amont DOIT être dans la phrase : c'est ce qui la rend un
    // diagnostic et pas une plainte.
    expect(rupture!.titre).toContain("640");
    expect(rupture!.titre).toContain("commande payée");
    expect(rapport.verdict).toBe("casse");
  });

  it("signale une chute invraisemblable entre deux étapes peuplées", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        evenements: [
          evenementEtape("cart_item_added", 4000),
          evenementEtape("checkout_started", 2000),
          evenementSain("order_confirmed", 3),
        ],
      })
    );

    const chute = rapport.constats.find(c => c.code === "chute_tunnel");
    expect(chute).toBeDefined();
    expect(chute!.certitude).toBe("mesure");
    expect(chute!.titre).toContain("2000");
    expect(chute!.titre).toContain("3");
  });

  it("ne crie pas sur un taux de conversion simplement médiocre", () => {
    // 1 % de checkout vers achat est mauvais commercialement, pas cassé
    // techniquement. Le diagnostic ne juge pas la performance du site.
    const rendus = codes(
      entreesSaines({
        evenements: [evenementEtape("checkout_started", 1000), evenementSain("order_confirmed", 12)],
      })
    );

    expect(rendus).toEqual([]);
  });

  it("expose le tunnel observé même quand une étape est absente", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({ evenements: [evenementEtape("cart_item_added", 640)], correspondances: [] })
    );

    const panier = rapport.observe.tunnel.find(e => e.etape === "ajout_panier");
    const achat = rapport.observe.tunnel.find(e => e.etape === "achat");
    expect(panier).toEqual({ etape: "ajout_panier", nomEmis: "cart_item_added", occurrences: 640 });
    // `nomEmis: null` dit « cette étape n'existe pas », que « 0 » ne dirait pas.
    expect(achat).toEqual({ etape: "achat", nomEmis: null, occurrences: 0 });
  });
});

/* ───────────────────── 4. Un site simplement pas instrumenté ────────────── */

describe("le site non instrumenté", () => {
  it("distingue « que des pages vues » d'un site muet", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({ pagesVues: 42000, totalLignes: 42000, evenements: [], nomsDistincts: 0, correspondances: [] })
    );

    const constat = rapport.constats.find(c => c.code === "aucun_evenement_metier");
    expect(constat).toBeDefined();
    expect(constat!.certitude).toBe("mesure");
    expect(constat!.titre).toContain("42000");
    expect(rapport.verdict).toBe("casse");
    // Et surtout : ce n'est PAS « aucune donnée ».
    expect(rapport.constats.some(c => c.code === "aucune_donnee")).toBe(false);
  });
});

/* ────────────────────── 5. La qualité des propriétés ────────────────────── */

describe("la qualité des propriétés des conversions", () => {
  it("signale une commande sans montant", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        evenements: [evenementSain("order_confirmed", 120, { avecValeur: 0, valeurMin: null, valeurMax: null, valeurMediane: null })],
      })
    );

    const constat = rapport.constats.find(c => c.code === "valeur_absente");
    expect(constat?.gravite).toBe("critique");
    expect(constat?.titre).toContain("120");
  });

  it("signale un montant partiellement présent", () => {
    const rendus = codes(
      entreesSaines({ evenements: [evenementSain("order_confirmed", 120, { avecValeur: 60 })] })
    );
    expect(rendus).toContain("valeur_partielle");
    expect(rendus).not.toContain("valeur_absente");
  });

  it("signale un montant illisible sans le confondre avec un montant absent", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        evenements: [evenementSain("order_confirmed", 120, { avecValeur: 0, valeurNonNumerique: 120 })],
      })
    );
    const rendus = rapport.constats.map(c => c.code);

    expect(rendus).toContain("valeur_non_numerique");
    // « la propriété est là mais illisible » n'est pas « la propriété manque » :
    // l'action à mener n'est pas la même.
    expect(rendus).not.toContain("valeur_absente");
  });

  it("attrape des centimes envoyés comme des euros", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        evenements: [
          evenementSain("order_confirmed", 120, { valeurMin: 1990, valeurMax: 24000, valeurMediane: 4990 }),
        ],
      })
    );

    const constat = rapport.constats.find(c => c.code === "valeur_ordre_de_grandeur");
    expect(constat).toBeDefined();
    expect(constat!.detail).toContain("centimes");
  });

  it("signale l'absence d'identifiant de déduplication (le trou d'ASD)", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({ evenements: [evenementSain("order_confirmed", 120, { avecIdentifiant: 0 })] })
    );

    const constat = rapport.constats.find(c => c.code === "identifiant_absent");
    expect(constat?.gravite).toBe("critique");
    expect(constat?.action).toContain("checkout_session_id");
  });

  it("signale un identifiant conditionnellement présent", () => {
    const rendus = codes(entreesSaines({ evenements: [evenementSain("order_confirmed", 120, { avecIdentifiant: 100 })] }));
    expect(rendus).toContain("identifiant_partiel");
  });

  it("signale un consentement publicitaire qui ne voyage pas, quand une régie est branchée", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({ evenements: [evenementSain("order_confirmed", 120, { avecConsentement: 0 })] })
    );

    const constat = rapport.constats.find(c => c.code === "consentement_absent");
    expect(constat?.gravite).toBe("critique");
    expect(constat?.titre).toContain("consentement publicitaire");
    // Le nom exact de la clé attendue doit figurer quelque part : sans lui, le
    // développeur du site ne sait pas quoi émettre.
    expect(constat?.detail).toContain("ads_consent_ad_user_data");
  });

  it("ne peut PAS affirmer que des propriétés ont été rejetées, seulement qu'on s'en approche", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        evenements: [evenementSain("order_confirmed", 120, { propsPresqueLongues: 8, propsTailleMax: 2001 })],
      })
    );

    const constat = rapport.constats.find(c => c.code === "props_proches_limite");
    expect(constat).toBeDefined();
    // 🔴 Les occurrences rejetées n'existent nulle part : ce constat ne peut pas
    // être `mesure`, sous peine d'affirmer un chiffre qu'on n'a pas.
    expect(constat!.certitude).toBe("indetermine");
    expect(constat!.detail).toContain("ne dit pas");
  });
});

/* ──────────────────── 6. Cohérence avec la config Ads ───────────────────── */

describe("la cohérence avec la configuration publicitaire", () => {
  it("signale une correspondance qui vise un événement jamais émis, et suggère le bon nom", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({ correspondances: [{ eventName: "order_paid", conversionActionId: "987654321" }] })
    );

    const constat = rapport.constats.find(c => c.code === "correspondance_sans_evenement");
    expect(constat).toBeDefined();
    expect(constat!.gravite).toBe("critique");
    expect(constat!.certitude).toBe("mesure");
    expect(constat!.titre).toContain("order_paid");
    // La suggestion est ce qui transforme le constat en réparation immédiate.
    expect(constat!.preuve.suggestion).toBe("order_confirmed");
    expect(rapport.verdict).toBe("casse");
  });

  it("ne suggère rien quand aucun nom émis n'est proche", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        correspondances: [{ eventName: "devis_signe_b2b", conversionActionId: "5" }],
        evenements: [evenementSain("order_confirmed", 120)],
      })
    );

    const constat = rapport.constats.find(c => c.code === "correspondance_sans_evenement");
    // Suggérer « order_confirmed » pour « devis_signe_b2b » enverrait le lecteur
    // corriger une correspondance qui n'a rien à voir.
    expect(constat!.preuve.suggestion).toBeNull();
  });

  it("signale une conversion mesurée qu'aucune correspondance ne couvre", () => {
    const rapport = diagnostiquerMesure(
      entreesSaines({
        evenements: [evenementSain("order_confirmed", 120), evenementSain("subscription_activated", 40)],
      })
    );

    const constat = rapport.constats.find(c => c.code === "conversion_non_declaree");
    expect(constat).toBeDefined();
    expect(constat!.titre).toContain("subscription_activated");
    expect(constat!.gravite).toBe("avertissement");
  });
});

/* ─────────────────────────── 7. Signaux d'alerte ────────────────────────── */

describe("les signaux d'alerte", () => {
  it("signale un trafic majoritairement issu de centres de données", () => {
    const rapport = diagnostiquerMesure(entreesSaines({ pagesVues: 1000, totalLignes: 2000, traficDatacenter: 900 }));

    const constat = rapport.constats.find(c => c.code === "trafic_datacenter");
    expect(constat).toBeDefined();
    expect(constat!.titre).toContain("900");
  });

  it("passe de l'avertissement au critique quand la limite de noms est atteinte", () => {
    const proche = diagnostiquerMesure(entreesSaines({ nomsDistincts: SEUIL_NOMS_EVENEMENTS })).constats.find(
      c => c.code === "noms_en_explosion"
    );
    const atteinte = diagnostiquerMesure(entreesSaines({ nomsDistincts: LIMITE_NOMS_EVENEMENTS })).constats.find(
      c => c.code === "noms_en_explosion"
    );

    expect(proche?.gravite).toBe("avertissement");
    expect(atteinte?.gravite).toBe("critique");
  });
});

/* ──────────────── 8. Propriétés générales de tout constat ───────────────── */

describe("la forme des constats", () => {
  it("chaque constat porte une action et une preuve non vides", () => {
    // Un constat sans action est une plainte. Cette règle vaut pour tous les
    // cas, y compris ceux qu'on ajoutera plus tard.
    const cas: EntreesDiagnostic[] = [
      entreesSaines({ pagesVues: 0, totalLignes: 0, evenements: [], nomsDistincts: 0 }),
      entreesSaines({ evenements: [evenementEtape("cart_item_added", 640)] }),
      entreesSaines({ evenements: [evenementSain("order_confirmed", 120, { avecValeur: 0, avecIdentifiant: 0, avecConsentement: 0 })] }),
      entreesSaines({ nomsDistincts: LIMITE_NOMS_EVENEMENTS, traficRobot: null }),
    ];

    for (const entrees of cas) {
      for (const constat of diagnostiquerMesure(entrees).constats) {
        expect(constat.action.length, `action vide pour ${constat.code}`).toBeGreaterThan(10);
        expect(constat.titre.length, `titre vide pour ${constat.code}`).toBeGreaterThan(10);
        expect(["critique", "avertissement", "information"]).toContain(constat.gravite);
        expect(["mesure", "indetermine"]).toContain(constat.certitude);
      }
    }
  });

  it("est déterministe : deux appels rendent le même rapport", () => {
    const entrees = entreesSaines({ evenements: [evenementSain("order_confirmed", 120, { avecValeur: 0 })] });
    expect(diagnostiquerMesure(entrees)).toEqual(diagnostiquerMesure(entrees));
  });
});
