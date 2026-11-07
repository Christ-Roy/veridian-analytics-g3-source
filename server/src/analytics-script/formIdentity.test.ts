import { describe, it, expect, beforeEach } from "vitest";
import { resolveFormIdentity, shortHash, FORM_NAME_ATTRIBUTE } from "./formIdentity.js";

function mount(html: string): HTMLFormElement {
  document.body.innerHTML = html;
  return document.querySelector("form") as HTMLFormElement;
}

describe("resolveFormIdentity", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  describe("formAction", () => {
    it("reste vide quand l'attribut action est absent", () => {
      // LE défaut d'origine : `form.action` est résolu par le navigateur sur
      // l'URL du document, donc il n'est JAMAIS vide même sans attribut. La
      // valeur avait l'air renseignée et ne voulait rien dire.
      const form = mount(`<form><input name="nom"></form>`);
      expect(form.action).not.toBe("");
      expect(resolveFormIdentity(form).formAction).toBe("");
    });

    it("rend l'attribut tel qu'écrit quand il est présent", () => {
      const form = mount(`<form action="/api/contact"><input name="nom"></form>`);
      expect(resolveFormIdentity(form).formAction).toBe("/api/contact");
    });
  });

  describe("formKey", () => {
    it("préfère l'attribut explicite à tout le reste", () => {
      const form = mount(
        `<form id="ignore-moi" name="moi-aussi" ${FORM_NAME_ATTRIBUTE}="Demande de devis"><input name="nom"></form>`
      );
      expect(resolveFormIdentity(form).formKey).toBe("demande-de-devis");
    });

    it("ignore l'accentuation dans la clé explicite", () => {
      const a = mount(`<form ${FORM_NAME_ATTRIBUTE}="Rappel téléphonique"></form>`);
      const keyA = resolveFormIdentity(a).formKey;
      const b = mount(`<form ${FORM_NAME_ATTRIBUTE}="Rappel telephonique"></form>`);
      expect(resolveFormIdentity(b).formKey).toBe(keyA);
    });

    it("retombe sur l'id, puis sur le name", () => {
      expect(resolveFormIdentity(mount(`<form id="contact"></form>`)).formKey).toBe("id:contact");
      expect(resolveFormIdentity(mount(`<form name="devis"></form>`)).formKey).toBe("name:devis");
    });

    it("dérive une clé stable des champs quand rien n'est déclaré", () => {
      // Le cas RÉEL des sites clients : ni id, ni name, ni action.
      const markup = `<form><input name="nom"><input name="email" type="email"><button type="submit">Envoyer</button></form>`;
      const first = resolveFormIdentity(mount(markup)).formKey;
      const second = resolveFormIdentity(mount(markup)).formKey;

      expect(first).toMatch(/^auto:/);
      expect(second).toBe(first);
    });

    it("distingue deux formulaires de champs différents sur la même page", () => {
      // Sans cela, deux formulaires d'une même page produisaient des
      // événements rigoureusement identiques.
      const contact = resolveFormIdentity(
        mount(`<form><input name="nom"><input name="email"></form>`)
      ).formKey;
      const newsletter = resolveFormIdentity(mount(`<form><input name="email"></form>`)).formKey;

      expect(contact).not.toBe(newsletter);
    });

    it("ne change pas quand seul le libellé du bouton change", () => {
      // Le texte du bouton nourrit le NOM lisible, jamais la clé : un simple
      // changement de libellé ne doit pas casser un objectif existant.
      const before = resolveFormIdentity(
        mount(`<form><input name="email"><button type="submit">Envoyer</button></form>`)
      ).formKey;
      const after = resolveFormIdentity(
        mount(`<form><input name="email"><button type="submit">Je m'abonne</button></form>`)
      ).formKey;

      expect(after).toBe(before);
    });

    it("n'est jamais vide, même sur un formulaire sans aucun champ", () => {
      expect(resolveFormIdentity(mount(`<form></form>`)).formKey).toBeTruthy();
    });
  });

  describe("formName", () => {
    it("prend le titre de la section à défaut de libellé propre", () => {
      const form = mount(
        `<section><h2>Demandez votre devis</h2><form><input name="nom"></form></section>`
      );
      expect(resolveFormIdentity(form).formName).toBe("Demandez votre devis");
    });

    it("prend le texte du bouton de soumission en dernier recours", () => {
      const form = mount(`<form><input name="nom"><button type="submit">Être rappelé</button></form>`);
      expect(resolveFormIdentity(form).formName).toBe("Être rappelé");
    });

    it("lit le libellé d'un input submit dans son attribut value", () => {
      const form = mount(`<form><input name="nom"><input type="submit" value="Envoyer"></form>`);
      expect(resolveFormIdentity(form).formName).toBe("Envoyer");
    });

    it("préfère aria-label au titre de section", () => {
      const form = mount(
        `<section><h2>Nos services</h2><form aria-label="Contact rapide"><input name="nom"></form></section>`
      );
      expect(resolveFormIdentity(form).formName).toBe("Contact rapide");
    });

    it("reste vide quand rien n'est déductible", () => {
      expect(resolveFormIdentity(mount(`<form><input name="a"></form>`)).formName).toBe("");
    });
  });
});

describe("shortHash", () => {
  it("est déterministe", () => {
    expect(shortHash("contact")).toBe(shortHash("contact"));
  });

  it("sépare des entrées différentes", () => {
    expect(shortHash("contact")).not.toBe(shortHash("devis"));
  });

  it("reste court", () => {
    expect(shortHash("a".repeat(500)).length).toBeLessThanOrEqual(7);
  });
});
