/**
 * Identité d'un formulaire.
 *
 * POURQUOI ce module existe : l'autocapture d'origine se contentait de
 * `form.id`, `form.name` et `form.action`. Sur les sites réels de Veridian —
 * React, `<form onSubmit={...}>` — ces trois attributs sont absents. Mesuré en
 * conditions réelles le 2026-08-19 sur un formulaire identique à celui des
 * clients :
 *
 *   {"formId":"","formName":"","formAction":"http://.../","method":"GET","fieldCount":3}
 *
 * Deux formulaires distincts d'une même page produisent donc des événements
 * rigoureusement identiques, inexploitables pour un objectif. Pire, `formAction`
 * n'est pas vide : le navigateur résout `form.action` sur l'URL du document
 * quand l'attribut manque. La valeur a l'air renseignée et ne veut rien dire,
 * ce qui est plus nuisible qu'un champ vide — on ne corrige pas ce qu'on ne
 * voit pas comme cassé.
 *
 * D'où deux propriétés distinctes, qui ne servent pas à la même chose :
 *  - `formKey`  : clé STABLE, pour cibler le formulaire dans un objectif ;
 *  - `formName` : libellé LISIBLE, pour reconnaître le formulaire dans un rapport.
 */

/** Résultat de la résolution d'identité d'un formulaire. */
export interface FormIdentity {
  /** Clé stable, utilisable comme critère d'objectif. Jamais vide. */
  formKey: string;
  /** Libellé lisible par un humain. Peut être vide si rien n'est déductible. */
  formName: string;
  /** `form.id` brut, conservé pour l'audit. */
  formId: string;
  /**
   * L'attribut `action` TEL QU'ÉCRIT dans le HTML, pas la propriété résolue
   * par le navigateur. Vide quand l'attribut est absent — c'est la correction
   * du faux positif décrit plus haut.
   */
  formAction: string;
}

/** Attribut posé sur un `<form>` pour nommer explicitement le formulaire. */
export const FORM_NAME_ATTRIBUTE = "data-rybbit-form";

const MAX_KEY_LENGTH = 64;
const MAX_NAME_LENGTH = 80;

/**
 * FNV-1a 32 bits, rendu en base 36.
 *
 * Choisi pour sa taille : l'empreinte voyage dans chaque événement et n'a
 * aucun rôle de sécurité, seulement de désambiguïsation. Une fonction
 * cryptographique coûterait du poids de script pour aucun bénéfice.
 */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiplication par le premier FNV 16777619, en arithmétique 32 bits.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function normalizeText(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  return (
    normalizeText(value)
      .toLowerCase()
      // Décompose puis retire les diacritiques, pour qu'une différence
      // d'accentuation ne produise pas deux clés distinctes.
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_KEY_LENGTH)
  );
}

/**
 * Signature structurelle : les noms et types des champs, dans l'ordre du DOM.
 *
 * Volontairement SANS le chemin de la page. Un même formulaire de contact
 * présent sur trois pages est un seul formulaire du point de vue du client, et
 * doit donc porter une seule clé. Contrepartie assumée : deux formulaires
 * réellement différents mais dotés de champs identiques se confondraient. Le
 * remède dans ce cas est l'attribut explicite, pas un durcissement de la
 * signature.
 */
function structuralSignature(form: HTMLFormElement): string {
  const parts: string[] = [];
  const elements = form.elements;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i] as HTMLInputElement;
    const tag = (element.tagName || "").toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") continue;
    const type = (element.type || "").toLowerCase();
    // Les boutons ne caractérisent pas le formulaire et changent au gré du
    // libellé ; les inclure rendrait la clé instable à la première retouche.
    if (type === "submit" || type === "button" || type === "reset" || type === "image") continue;
    const name = element.name || element.id || "";
    parts.push(`${tag}:${type}:${name}`);
  }
  return parts.join("|");
}

/** Texte du bouton de soumission, souvent le meilleur nom lisible disponible. */
function submitButtonText(form: HTMLFormElement): string {
  const elements = form.elements;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i] as HTMLInputElement;
    const type = (element.type || "").toLowerCase();
    if (type !== "submit") continue;
    const tag = (element.tagName || "").toLowerCase();
    // `<input type="submit">` porte son libellé dans `value`,
    // `<button type="submit">` dans son contenu textuel.
    const text = tag === "input" ? element.value : normalizeText(element.textContent);
    if (text) return normalizeText(text);
  }
  return "";
}

function labelledByText(form: HTMLFormElement): string {
  const ids = (form.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  const texts = ids
    .map(id => {
      try {
        return normalizeText(document.getElementById(id)?.textContent);
      } catch (e) {
        return "";
      }
    })
    .filter(Boolean);
  return texts.join(" ");
}

/** Titre de la section qui contient le formulaire, à défaut de mieux. */
function nearestHeadingText(form: HTMLFormElement): string {
  try {
    const inside = form.querySelector("legend, h1, h2, h3, h4");
    if (inside) return normalizeText(inside.textContent);

    const section = form.closest("section, article, aside, main, div[id]");
    const heading = section?.querySelector("h1, h2, h3, h4");
    if (heading) return normalizeText(heading.textContent);
  } catch (e) {
    // `closest`/`querySelector` peuvent lever sur des sélecteurs exotiques
    // selon le navigateur : l'identité est un confort, jamais un motif de
    // casser la page du client.
  }
  return "";
}

/**
 * Résout l'identité d'un formulaire.
 *
 * Ordre de préférence pour la clé, du plus fiable au plus déduit. Le premier
 * niveau est celui qu'on veut voir adopté sur les sites clients : une seule
 * mention `data-rybbit-form="contact"` supprime toute ambiguïté et survit à
 * n'importe quelle refonte du balisage.
 */
export function resolveFormIdentity(form: HTMLFormElement): FormIdentity {
  const explicit = normalizeText(form.getAttribute(FORM_NAME_ATTRIBUTE));
  const formId = form.id || "";
  const nativeName = form.getAttribute("name") || "";
  const ariaLabel = normalizeText(form.getAttribute("aria-label"));

  let formKey: string;
  if (explicit) {
    formKey = slugify(explicit) || `form-${shortHash(explicit)}`;
  } else if (formId) {
    formKey = `id:${formId.slice(0, MAX_KEY_LENGTH)}`;
  } else if (nativeName) {
    formKey = `name:${nativeName.slice(0, MAX_KEY_LENGTH)}`;
  } else {
    // Aucun identifiant déclaré : on retombe sur la signature des champs.
    // Le préfixe `auto:` est un signal explicite pour le lecteur du rapport —
    // « personne n'a nommé ce formulaire », donc la clé peut bouger si les
    // champs changent.
    formKey = `auto:${shortHash(structuralSignature(form))}`;
  }

  const formName =
    explicit ||
    ariaLabel ||
    labelledByText(form) ||
    nearestHeadingText(form) ||
    submitButtonText(form) ||
    nativeName ||
    formId ||
    "";

  return {
    formKey,
    formName: formName.slice(0, MAX_NAME_LENGTH),
    formId,
    // `getAttribute` et non `form.action` : voir l'en-tête du module.
    formAction: form.getAttribute("action") || "",
  };
}
