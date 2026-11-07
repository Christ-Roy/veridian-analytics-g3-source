/**
 * Ce que ces tests protègent : des chiffres TROP BAS, jamais des erreurs.
 *
 * Les fautes de cette brique ne lèvent pas. Elles rendent un nombre plus petit,
 * parfaitement plausible, sur lequel un client conclut que sa publicité ne sert
 * à rien. Trois d'entre elles sont figées ici.
 */
import { describe, expect, it, vi } from "vitest";
import {
  EVENEMENTS_TECHNIQUES,
  PARAMETRES_CLIC,
  construireRequeteActionsPayantes,
  construireRequeteTraficPaye,
  lireTraficPaye,
} from "./trafic-paye.js";

describe("les trois identifiants de clic", () => {
  it("cherche gbraid et wbraid, pas seulement gclid", () => {
    // Ne chercher que `gclid` classerait le trafic iOS et YouTube en « direct »,
    // c'est-à-dire attribuerait à l'organique des visites payées. Le chiffre
    // resterait plausible, simplement faux, et toujours dans le même sens.
    expect([...PARAMETRES_CLIC].sort()).toEqual(["gbraid", "gclid", "wbraid"]);
    const spec = construireRequeteTraficPaye(8, "2026-08-06", "2026-09-04");
    expect(spec.params!.parametres).toEqual(["gclid", "gbraid", "wbraid"]);
  });
});

describe("la session est l'unité, pas l'événement", () => {
  it("qualifie la SESSION puis rattache ses événements", () => {
    // 🔴 LE test de ce fichier. L'identifiant de clic n'est présent que sur le
    // PREMIER événement de la session — celui qui portait le paramètre d'URL.
    // Filtrer les événements sur leur propre `gclid` rendrait trois à cinq fois
    // moins d'actions, sans qu'aucune erreur ne le signale.
    const q = construireRequeteActionsPayantes(8, "2026-08-06", "2026-09-04").query;
    expect(q).toContain("sessions_payantes");
    expect(q).toContain("session_id IN (SELECT session_id FROM sessions_payantes)");
    // La condition sur les paramètres d'URL ne doit apparaître QU'UNE FOIS,
    // dans la sous-requête qui qualifie les sessions, jamais sur les événements.
    //
    // ⚠️ Première version de cette assertion : elle découpait la requête au
    // premier `)` suivant l'ouverture de la sous-requête. Or ce `)` est celui de
    // `toDateTime(...)`, pas la fin du bloc — le test échouait sur une requête
    // parfaitement juste. Compter les occurrences ne dépend d'aucun découpage.
    expect(q.match(/url_parameters/g) ?? []).toHaveLength(1);
  });
});

describe("les événements techniques sont exclus", () => {
  it("écarte web-vitals, qui est émis à chaque page", () => {
    // Mesuré : 98 `web-vitals` pour 3 clics téléphone sur le site 8. Les
    // compter ferait afficher « 98 actions » pour trois appels.
    expect([...EVENEMENTS_TECHNIQUES]).toContain("web-vitals");
    const spec = construireRequeteActionsPayantes(8, "2026-08-06", "2026-09-04");
    expect(spec.params!.techniques).toContain("web-vitals");
    expect(spec.query).toContain("event_name NOT IN ({techniques:Array(String)})");
  });

  it("écarte aussi les erreurs JavaScript", () => {
    // Elles sont émises par le traceur, pas par le visiteur : les compter comme
    // des actions ferait passer un site cassé pour un site performant.
    for (const nom of ["Error", "TypeError"]) expect([...EVENEMENTS_TECHNIQUES]).toContain(nom);
  });
});

describe("bornes de dates", () => {
  it("couvre le jour entier, minuit à 23:59:59", () => {
    // Sans les heures, ClickHouse compare une date à un `DateTime` et exclut
    // tout le dernier jour. Le total serait juste à un jour près — l'erreur la
    // plus difficile à voir, parce qu'elle ne saute aux yeux que sur une
    // période d'un seul jour.
    const spec = construireRequeteTraficPaye(8, "2026-08-06", "2026-09-04");
    expect(String(spec.params!.debut)).toContain("00:00:00");
    expect(String(spec.params!.fin)).toContain("23:59:59");
  });
});

describe("lireTraficPaye", () => {
  it("convertit les agrégats rendus en CHAÎNES par ClickHouse", async () => {
    // ClickHouse rend ses grands entiers en chaînes. Les laisser tels quels
    // ferait faire des concaténations là où on attend des additions : "23" + 1
    // vaut "231", et rien ne le signale.
    const executer = vi
      .fn()
      .mockResolvedValueOnce([{ sessionsTotal: "100", sessionsPayantes: "23", visiteursPayants: "21" }])
      .mockResolvedValueOnce([{ nom: "phone_click", sessions: "3", total: "3" }]);
    const r = await lireTraficPaye(8, "2026-08-06", "2026-09-04", { executer });
    expect(r.sessionsTotal).toBe(100);
    expect(r.sessionsPayantes).toBe(23);
    expect(r.visiteursPayants).toBe(21);
    expect(r.actions[0]).toEqual({ nom: "phone_click", sessions: 3, total: 3 });
  });

  it("rend des zéros, pas une exception, quand la requête ne rend rien", async () => {
    // Un site sans aucun trafic sur la période est un cas NORMAL. Lever ici
    // ferait rougir l'écran d'un site simplement calme.
    const executer = vi.fn().mockResolvedValue([]);
    const r = await lireTraficPaye(8, "2026-08-06", "2026-09-04", { executer });
    expect(r).toEqual({ sessionsTotal: 0, sessionsPayantes: 0, visiteursPayants: 0, actions: [] });
  });
});
