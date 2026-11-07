/**
 * Capture des VALEURS saisies dans un formulaire.
 *
 * Cette capture est désactivée par défaut et ne s'active que par le réglage de
 * site `trackFormFields`. Elle sert à récupérer la donnée commerciale
 * first-party (nom, e-mail, téléphone, message) sur les propres formulaires du
 * client, pas à aspirer tout ce qui passe.
 *
 * PRINCIPE DE CONCEPTION : la liste d'exclusion n'est PAS une liste de bonnes
 * intentions, c'est un filtre à deux étages qui se déclenche même quand le
 * champ est mal nommé.
 *
 *  1. Exclusion STRUCTURELLE — le type du champ suffit à décider (mot de
 *     passe, champ caché, fichier). Ces champs ne sont jamais lus.
 *  2. Exclusion par MOTIF — le nom du champ OU sa valeur ressemble à un
 *     secret (carte bancaire vérifiée par Luhn, IBAN, jeton, clé d'API). Le
 *     champ est alors remplacé par un marqueur.
 *
 * Le second étage existe parce que le premier ne suffit pas : un numéro de
 * carte saisi dans un `<input type="text">` nommé « champ3 » passerait
 * l'étage 1 sans encombre. Un numéro de carte dans une base analytics est un
 * incident de sécurité, pas une donnée — et il n'y a aucune raison de faire
 * confiance au balisage d'un site qu'on n'a pas écrit.
 *
 * Pourquoi un MARQUEUR plutôt qu'une suppression pure à l'étage 2 : un faux
 * positif (une phrase légitime prise pour un jeton) doit rester visible pour
 * être corrigé. Un champ absent est indiscernable d'un champ vide ; un champ
 * marqué se remarque.
 */

/** Marqueur substitué à une valeur jugée sensible. */
export const REDACTED = "[exclu]";

/** Attribut d'échappement, posable sur un champ ou sur n'importe quel ancêtre. */
export const FIELD_IGNORE_ATTRIBUTE = "data-rybbit-ignore";

export interface FieldCaptureLimits {
  /** Nombre maximum de champs remontés. */
  maxFields: number;
  /** Longueur maximale d'une valeur, en caractères. */
  maxValueLength: number;
  /** Budget total, en caractères, toutes valeurs confondues. */
  maxTotalLength: number;
}

/**
 * Plafonds par défaut.
 *
 * `maxTotalLength` vaut 1200 et NON 2048, alors que 2048 est la limite du
 * serveur (`trackingPayload.ts`, schéma `form_submit`). L'écart est
 * volontaire : les propriétés structurelles — clé, nom, action, méthode,
 * issue, code HTTP, délai — et la ponctuation JSON occupent la différence. Un
 * budget calé sur 2048 produirait un objet légèrement au-dessus de la limite,
 * et le serveur rejetterait l'événement ENTIER : on perdrait la soumission
 * pour avoir voulu garder un champ de trop.
 */
export const DEFAULT_FIELD_LIMITS: FieldCaptureLimits = {
  maxFields: 30,
  maxValueLength: 200,
  maxTotalLength: 1200,
};

/** Types de champs jamais lus, quelle que soit leur valeur. */
const EXCLUDED_INPUT_TYPES = new Set([
  "password",
  "hidden",
  "file",
  "submit",
  "button",
  "image",
  "reset",
]);

/**
 * Noms de champs réputés sensibles.
 *
 * Volontairement RESTREINT aux secrets réels. `siret`, `tva` ou `societe` sont
 * de la donnée commerciale que Robert veut justement récupérer : les exclure
 * « par prudence » viderait la fonctionnalité de son intérêt.
 */
const SENSITIVE_NAME_PATTERN =
  /(pass|pwd|mot[-_ ]?de[-_ ]?passe|card|carte[-_ ]?bancaire|cc[-_ ]?num|cardnum|cvv|cvc|crypto?gramme|iban|bic|swift|rib|secret|token|jeton|api[-_ ]?key|apikey|auth|ssn|routing)/i;

/** Valeurs d'`autocomplete` qui désignent un moyen de paiement. */
const SENSITIVE_AUTOCOMPLETE_PATTERN = /(cc-|current-password|new-password)/i;

/** IBAN : 2 lettres de pays, 2 chiffres de contrôle, puis 10 à 30 alphanumériques. */
const IBAN_PATTERN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/;

/** Jeton JWT. */
const JWT_PATTERN = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;

/** Clés d'API usuelles (Stripe, Rybbit, GitHub…). */
const API_KEY_PATTERN = /^(sk|pk|rk|rb|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}/i;

/**
 * Chaîne longue sans espace : signature d'un secret opaque.
 *
 * La longueur seule ne suffit PAS. Un premier jet exigeait seulement 40
 * caractères sans espace, et masquait de ce fait un long message rédigé sans
 * espace — un faux positif qui aurait supprimé de la donnée commerciale
 * légitime en silence. La règle exige donc en plus un MÉLANGE de lettres et de
 * chiffres, ce qui est la marque d'un identifiant généré et jamais celle d'un
 * texte écrit par une personne.
 */
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,}$/;
const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /[0-9]/;

/**
 * Algorithme de Luhn.
 *
 * C'est ce contrôle qui distingue un vrai numéro de carte d'un numéro de
 * commande ou d'un numéro de série de même longueur. Sans lui, on excluerait
 * à tort toute suite de 16 chiffres.
 */
export function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return false;
    let value = code;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Une valeur ressemble-t-elle à un secret ? */
export function looksSensitive(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  // Carte bancaire : on retire les séparateurs usuels avant de tester Luhn.
  const digitsOnly = trimmed.replace(/[ \-.]/g, "");
  if (/^[0-9]+$/.test(digitsOnly) && passesLuhn(digitsOnly)) return true;

  const compact = trimmed.replace(/\s/g, "");
  if (IBAN_PATTERN.test(compact.toUpperCase())) return true;
  if (JWT_PATTERN.test(compact)) return true;
  if (API_KEY_PATTERN.test(compact)) return true;
  // Le test du jeton opaque ne s'applique qu'à une valeur d'un seul tenant,
  // mêlant lettres ET chiffres : un message de contact contient des espaces,
  // et un mot très long n'en contient pas.
  if (
    !/\s/.test(trimmed) &&
    OPAQUE_TOKEN_PATTERN.test(trimmed) &&
    HAS_LETTER.test(trimmed) &&
    HAS_DIGIT.test(trimmed)
  ) {
    return true;
  }

  return false;
}

/** Le NOM du champ désigne-t-il un secret ? */
export function sensitiveByName(element: HTMLInputElement): boolean {
  const name = `${element.name || ""} ${element.id || ""} ${element.getAttribute("aria-label") || ""}`;
  if (SENSITIVE_NAME_PATTERN.test(name)) return true;
  const autocomplete = element.getAttribute("autocomplete") || "";
  return SENSITIVE_AUTOCOMPLETE_PATTERN.test(autocomplete);
}

/** Le champ, ou l'un de ses ancêtres, porte-t-il l'attribut d'échappement ? */
function isOptedOut(element: Element): boolean {
  try {
    return element.closest(`[${FIELD_IGNORE_ATTRIBUTE}]`) !== null;
  } catch (e) {
    // `closest` indisponible sur un élément détaché : dans le doute, on
    // n'exclut pas — le filtre par motif reste en place derrière.
    return false;
  }
}

/** Nom lisible d'un champ, même quand l'attribut `name` manque. */
function fieldKey(element: HTMLInputElement): string {
  const raw =
    element.name ||
    element.id ||
    element.getAttribute("aria-label") ||
    element.getAttribute("placeholder") ||
    "";
  return raw.replace(/\s+/g, "_").slice(0, 40);
}

function selectedText(element: HTMLSelectElement): string {
  const options = Array.from(element.selectedOptions || []);
  return options.map(option => (option.textContent || option.value || "").trim()).join(", ");
}

/**
 * Extrait les valeurs d'un formulaire.
 *
 * Retourne un objet PLAT : `{ nom: "Jean", email: "jean@example.com" }`.
 * La platitude n'est pas un détail — l'interface des sessions affiche chaque
 * propriété comme une pastille, et un objet imbriqué s'y afficherait comme un
 * bloc JSON illisible. Un objet plat est aussi ce que sait cibler un objectif
 * « propriété d'événement ».
 */
export function captureFormFields(
  form: HTMLFormElement,
  limits: FieldCaptureLimits = DEFAULT_FIELD_LIMITS
): Record<string, string> {
  const fields: Record<string, string> = {};
  let used = 0;
  let count = 0;

  const elements = form.elements;
  for (let i = 0; i < elements.length; i++) {
    if (count >= limits.maxFields || used >= limits.maxTotalLength) break;

    const element = elements[i] as HTMLInputElement;
    const tag = (element.tagName || "").toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") continue;

    const type = (element.type || "").toLowerCase();

    // --- Étage 1 : exclusion structurelle -------------------------------
    if (EXCLUDED_INPUT_TYPES.has(type)) continue;
    if (element.disabled) continue;
    if (isOptedOut(element)) continue;

    const key = fieldKey(element);
    if (!key) continue;

    // --- Lecture de la valeur ------------------------------------------
    let value: string;
    if (type === "checkbox") {
      value = element.checked ? "true" : "false";
    } else if (type === "radio") {
      // Seule l'option cochée porte une information.
      if (!element.checked) continue;
      value = element.value || "true";
    } else if (tag === "select") {
      value = selectedText(element as unknown as HTMLSelectElement);
    } else {
      value = element.value || "";
    }

    value = value.trim();
    if (!value) continue;

    // --- Étage 2 : exclusion par motif ----------------------------------
    if (sensitiveByName(element) || looksSensitive(value)) {
      fields[key] = REDACTED;
      count++;
      used += REDACTED.length;
      continue;
    }

    if (value.length > limits.maxValueLength) {
      value = `${value.slice(0, limits.maxValueLength)}…`;
    }

    // Le budget global s'applique APRÈS la troncature par champ : un seul
    // message long ne doit pas évincer tous les champs qui le suivent.
    const remaining = limits.maxTotalLength - used;
    if (remaining <= 0) break;
    if (value.length > remaining) {
      value = `${value.slice(0, remaining)}…`;
    }

    fields[key] = value;
    used += value.length;
    count++;
  }

  return fields;
}
