import { describe, it, expect, beforeEach } from "vitest";
import {
  captureFormFields,
  looksSensitive,
  passesLuhn,
  sensitiveByName,
  REDACTED,
  FIELD_IGNORE_ATTRIBUTE,
} from "./formFields.js";

function mount(html: string): HTMLFormElement {
  document.body.innerHTML = html;
  return document.querySelector("form") as HTMLFormElement;
}

describe("passesLuhn", () => {
  it("accepte des numéros de carte de test valides", () => {
    // Numéros de test publics des réseaux, jamais rattachés à un compte.
    expect(passesLuhn("4242424242424242")).toBe(true);
    expect(passesLuhn("5555555555554444")).toBe(true);
    expect(passesLuhn("378282246310005")).toBe(true);
  });

  it("rejette une suite de chiffres qui n'est pas une carte", () => {
    // C'est tout l'intérêt du contrôle : un numéro de commande de 16 chiffres
    // ne doit pas être exclu par erreur.
    expect(passesLuhn("1234567890123456")).toBe(false);
  });

  it("rejette les longueurs hors plage", () => {
    expect(passesLuhn("42424242")).toBe(false);
    expect(passesLuhn("4".repeat(25))).toBe(false);
  });
});

describe("looksSensitive", () => {
  it("repère une carte bancaire, séparateurs compris", () => {
    expect(looksSensitive("4242 4242 4242 4242")).toBe(true);
    expect(looksSensitive("4242-4242-4242-4242")).toBe(true);
  });

  it("repère un IBAN", () => {
    expect(looksSensitive("FR7630006000011234567890189")).toBe(true);
    expect(looksSensitive("FR76 3000 6000 0112 3456 7890 189")).toBe(true);
  });

  it("repère un JWT et une clé d'API", () => {
    expect(looksSensitive("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc")).toBe(true);
    expect(looksSensitive(["sk", "live", "51H8xKjKlPqRsTuVwXyZ0123456789"].join("_"))).toBe(true);
  });

  it("laisse passer une donnée commerciale ordinaire", () => {
    // Le filtre doit rester chirurgical : ces valeurs sont exactement ce que
    // la fonctionnalité doit récupérer.
    expect(looksSensitive("Jean Dupont")).toBe(false);
    expect(looksSensitive("jean.dupont@example.com")).toBe(false);
    expect(looksSensitive("06 29 45 43 11")).toBe(false);
    expect(looksSensitive("Bonjour, je souhaite un devis pour 40 m2 de peinture.")).toBe(false);
  });

  it("laisse passer un mot très long sans espace", () => {
    // Régression : une règle « 40 caractères sans espace » suffisait, et
    // masquait donc un texte légitime écrit d'un seul tenant. Un jeton mêle
    // lettres ET chiffres ; un mot, non.
    expect(looksSensitive("a".repeat(300))).toBe(false);
    expect(looksSensitive("anticonstitutionnellementanticonstitutionnellement")).toBe(false);
  });

  it("repère un identifiant généré mêlant lettres et chiffres", () => {
    expect(looksSensitive("a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0")).toBe(true);
  });

  it("laisse passer un numéro de TVA ou de SIRET", () => {
    // Donnée commerciale légitime : l'exclure « par prudence » viderait la
    // fonctionnalité de son intérêt sur les formulaires professionnels.
    expect(looksSensitive("FR12345678901")).toBe(false);
    expect(looksSensitive("123 456 789 00012")).toBe(false);
  });
});

describe("sensitiveByName", () => {
  it("repère un champ nommé comme un secret", () => {
    const form = mount(
      `<form><input name="cvv"><input name="numero_carte_bancaire"><input id="iban"><input name="api_key"></form>`
    );
    const inputs = Array.from(form.querySelectorAll("input")) as HTMLInputElement[];
    for (const input of inputs) {
      expect(sensitiveByName(input)).toBe(true);
    }
  });

  it("repère un autocomplete de moyen de paiement", () => {
    const form = mount(`<form><input name="champ3" autocomplete="cc-number"></form>`);
    expect(sensitiveByName(form.querySelector("input") as HTMLInputElement)).toBe(true);
  });

  it("laisse passer les champs ordinaires", () => {
    const form = mount(`<form><input name="nom"><input name="email"><input name="societe"></form>`);
    const inputs = Array.from(form.querySelectorAll("input")) as HTMLInputElement[];
    for (const input of inputs) {
      expect(sensitiveByName(input)).toBe(false);
    }
  });
});

describe("captureFormFields", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("capture les valeurs commerciales utiles", () => {
    const form = mount(`
      <form>
        <input name="nom" value="Jean Dupont">
        <input name="email" type="email" value="jean@example.com">
        <input name="telephone" type="tel" value="0629454311">
        <textarea name="message">Devis pour 40 m2</textarea>
      </form>
    `);

    expect(captureFormFields(form)).toEqual({
      nom: "Jean Dupont",
      email: "jean@example.com",
      telephone: "0629454311",
      message: "Devis pour 40 m2",
    });
  });

  it("ne lit jamais un mot de passe, un champ caché ou un fichier", () => {
    const form = mount(`
      <form>
        <input name="nom" value="Jean">
        <input name="motdepasse" type="password" value="hunter2">
        <input name="csrf" type="hidden" value="jeton-secret">
        <input name="piece" type="file">
      </form>
    `);

    const fields = captureFormFields(form);
    expect(fields).toEqual({ nom: "Jean" });
    expect(JSON.stringify(fields)).not.toContain("hunter2");
    expect(JSON.stringify(fields)).not.toContain("jeton-secret");
  });

  it("masque une carte bancaire saisie dans un champ mal nommé", () => {
    // Le cas qui justifie le second étage du filtre : le balisage d'un site
    // qu'on n'a pas écrit ne mérite aucune confiance.
    const form = mount(`<form><input name="champ3" value="4242 4242 4242 4242"></form>`);
    expect(captureFormFields(form)).toEqual({ champ3: REDACTED });
  });

  it("masque un champ nommé comme un secret sans regarder sa valeur", () => {
    const form = mount(`<form><input name="cvv" value="123"></form>`);
    expect(captureFormFields(form)).toEqual({ cvv: REDACTED });
  });

  it("respecte l'attribut d'échappement, y compris sur un ancêtre", () => {
    const form = mount(`
      <form>
        <input name="nom" value="Jean">
        <input name="prive" value="secret" ${FIELD_IGNORE_ATTRIBUTE}>
        <div ${FIELD_IGNORE_ATTRIBUTE}><input name="aussi_prive" value="secret"></div>
      </form>
    `);
    expect(captureFormFields(form)).toEqual({ nom: "Jean" });
  });

  it("capture l'état des cases et la seule option radio cochée", () => {
    const form = mount(`
      <form>
        <input name="newsletter" type="checkbox" checked>
        <input name="cgv" type="checkbox">
        <input name="urgence" type="radio" value="oui">
        <input name="urgence" type="radio" value="non" checked>
      </form>
    `);
    expect(captureFormFields(form)).toEqual({
      newsletter: "true",
      cgv: "false",
      urgence: "non",
    });
  });

  it("capture le libellé lisible d'un select, pas sa valeur technique", () => {
    const form = mount(`
      <form>
        <select name="prestation">
          <option value="1">Peinture intérieure</option>
          <option value="2" selected>Ravalement de façade</option>
        </select>
      </form>
    `);
    expect(captureFormFields(form)).toEqual({ prestation: "Ravalement de façade" });
  });

  it("ignore les champs vides et les champs désactivés", () => {
    const form = mount(`
      <form>
        <input name="nom" value="Jean">
        <input name="vide" value="">
        <input name="inactif" value="quelque chose" disabled>
      </form>
    `);
    expect(captureFormFields(form)).toEqual({ nom: "Jean" });
  });

  it("nomme un champ par son placeholder quand l'attribut name manque", () => {
    const form = mount(`<form><input placeholder="Votre e-mail" value="jean@example.com"></form>`);
    expect(captureFormFields(form)).toEqual({ "Votre_e-mail": "jean@example.com" });
  });

  it("tronque une valeur trop longue", () => {
    const form = mount(`<form><input name="message"></form>`);
    (form.querySelector("input") as HTMLInputElement).value = "a".repeat(500);

    const fields = captureFormFields(form, { maxFields: 30, maxValueLength: 10, maxTotalLength: 2000 });
    expect(fields.message).toBe(`${"a".repeat(10)}…`);
  });

  it("plafonne le nombre de champs", () => {
    const inputs = Array.from({ length: 10 }, (_, i) => `<input name="c${i}" value="v${i}">`).join("");
    const form = mount(`<form>${inputs}</form>`);

    const fields = captureFormFields(form, { maxFields: 3, maxValueLength: 200, maxTotalLength: 2000 });
    expect(Object.keys(fields)).toHaveLength(3);
  });

  it("plafonne le volume total sans évincer les champs suivants d'un seul coup", () => {
    const form = mount(`<form><input name="long"><input name="court" value="ok"></form>`);
    (form.querySelector('input[name="long"]') as HTMLInputElement).value = "a".repeat(300);

    const fields = captureFormFields(form, { maxFields: 30, maxValueLength: 200, maxTotalLength: 40 });
    const total = Object.values(fields).join("").length;
    expect(total).toBeLessThanOrEqual(45);
  });

  it("capture le pot de miel, qui est un vrai champ texte", () => {
    // Les sites clients posent un champ leurre hors écran, rempli par les
    // robots. Le voir renseigné en base est une information utile, pas une fuite.
    const form = mount(`
      <form>
        <div style="position:absolute;left:-9999px"><input name="societe" value="spam"></div>
        <input name="nom" value="Jean">
      </form>
    `);
    expect(captureFormFields(form)).toEqual({ societe: "spam", nom: "Jean" });
  });
});
