import { describe, it, expect, beforeEach, vi } from "vitest";
import { FormTrackingManager } from "./formTracking.js";
import type { Tracker } from "./tracking.js";
import type { ScriptConfig } from "./types.js";

/**
 * Ces tests couvrent le point d'entrée du suivi de formulaire — celui qui
 * décide de ce qui part réellement dans l'événement natif `form_submit`.
 *
 * Ils comptent particulièrement parce que le tracker est servi à 16 sites
 * clients en production : une régression ici ne casse pas une page, elle rend
 * la mesure muette ou inexploitable, sans lever d'erreur nulle part.
 */

function monter(html: string): HTMLFormElement {
  document.body.innerHTML = html;
  return document.querySelector("form") as HTMLFormElement;
}

function faireUnTracker() {
  return { trackFormSubmit: vi.fn(), trackEvent: vi.fn() } as unknown as Tracker & {
    trackFormSubmit: ReturnType<typeof vi.fn>;
  };
}

function faireUneConfig(surcharge: Partial<ScriptConfig> = {}): ScriptConfig {
  return { trackFormInteractions: true, trackFormFields: false, ...surcharge } as ScriptConfig;
}

describe("FormTrackingManager", () => {
  let tracker: ReturnType<typeof faireUnTracker>;

  beforeEach(() => {
    document.body.innerHTML = "";
    tracker = faireUnTracker();
  });

  function soumettre(form: HTMLFormElement, config = faireUneConfig()) {
    const manager = new FormTrackingManager(tracker, config);
    manager.initialize();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    manager.cleanup();
    return tracker.trackFormSubmit.mock.calls[0]?.[0];
  }

  it("émet l'événement natif sur une soumission", () => {
    const form = monter(`<form id="contact"><input name="nom"></form>`);
    soumettre(form);
    expect(tracker.trackFormSubmit).toHaveBeenCalledTimes(1);
  });

  // Le cas RÉEL de tous les formulaires clients : React avec `onSubmit`, sans
  // id ni action. L'événement `submit` natif part quand même — c'est ce qui
  // rend l'autocapture possible sans toucher au code des sites.
  it("émet même quand la soumission est annulée par preventDefault", () => {
    const form = monter(`<form><input name="nom"></form>`);
    form.addEventListener("submit", e => e.preventDefault());
    soumettre(form);
    expect(tracker.trackFormSubmit).toHaveBeenCalledTimes(1);
  });

  // Anti-régression du défaut qui rendait l'événement inexploitable : deux
  // formulaires sans identifiant produisaient exactement la même propriété.
  it("donne une clé stable et distincte à deux formulaires anonymes", () => {
    document.body.innerHTML = `
      <form id="f1"><input name="nom"><input name="email"></form>
      <form id="f2"><input name="societe"><input name="siret"><input name="tva"></form>`;
    const [a, b] = Array.from(document.querySelectorAll("form"));
    const manager = new FormTrackingManager(tracker, faireUneConfig());
    manager.initialize();
    a.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    b.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    manager.cleanup();

    const cle1 = tracker.trackFormSubmit.mock.calls[0][0].formKey;
    const cle2 = tracker.trackFormSubmit.mock.calls[1][0].formKey;
    expect(cle1).toBeTruthy();
    expect(cle2).toBeTruthy();
    expect(cle1).not.toBe(cle2);
  });

  // `formAction` valait l'URL de la page quand l'attribut était absent : une
  // valeur qui a l'air renseignée et ne distingue rien.
  it("ne rend pas l'URL de la page comme action quand l'attribut est absent", () => {
    const form = monter(`<form><input name="nom"></form>`);
    const props = soumettre(form);
    expect(form.action).not.toBe("");
    expect(props.formAction).toBe("");
  });

  it("ignore un événement submit qui ne vient pas d'un formulaire", () => {
    document.body.innerHTML = `<div id="faux"></div>`;
    const manager = new FormTrackingManager(tracker, faireUneConfig());
    manager.initialize();
    document.getElementById("faux")!.dispatchEvent(new Event("submit", { bubbles: true }));
    manager.cleanup();
    expect(tracker.trackFormSubmit).not.toHaveBeenCalled();
  });

  describe("valeurs de champ", () => {
    // Le réglage est par site et désactivé par défaut : sans lui, aucune
    // valeur saisie ne doit sortir de la page.
    it("ne capture aucune valeur quand trackFormFields est éteint", () => {
      const form = monter(`<form id="c"><input name="email" value="jean@exemple.fr"></form>`);
      const props = soumettre(form, faireUneConfig({ trackFormFields: false }));
      expect(JSON.stringify(props)).not.toContain("jean@exemple.fr");
    });

    it("capture les valeurs quand le réglage est actif", () => {
      const form = monter(`<form id="c"><input name="email" value="jean@exemple.fr"></form>`);
      const props = soumettre(form, faireUneConfig({ trackFormFields: true }));
      expect(JSON.stringify(props)).toContain("jean@exemple.fr");
    });

    // Exclusion dure : un mot de passe ne doit jamais sortir, même réglage actif.
    it("n'émet jamais un mot de passe, même réglage actif", () => {
      const form = monter(
        `<form id="c"><input name="email" value="jean@exemple.fr"><input type="password" name="mdp" value="secret-du-client"></form>`
      );
      const props = soumettre(form, faireUneConfig({ trackFormFields: true }));
      expect(JSON.stringify(props)).not.toContain("secret-du-client");
    });
  });

  it("cesse d'écouter après cleanup", () => {
    const form = monter(`<form id="c"><input name="nom"></form>`);
    const manager = new FormTrackingManager(tracker, faireUneConfig());
    manager.initialize();
    manager.cleanup();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(tracker.trackFormSubmit).not.toHaveBeenCalled();
  });
});
