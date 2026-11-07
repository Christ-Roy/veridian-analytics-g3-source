import { ScriptConfig, FormSubmitProperties, InputChangeProperties } from "./types.js";
import { Tracker } from "./tracking.js";
import { resolveFormIdentity } from "./formIdentity.js";
import { captureFormFields } from "./formFields.js";

export class FormTrackingManager {
  private tracker: Tracker;
  private config: ScriptConfig;
  private boundHandleSubmit: (event: Event) => void;
  private boundHandleChange: (event: Event) => void;

  constructor(tracker: Tracker, config: ScriptConfig) {
    this.tracker = tracker;
    this.config = config;
    this.boundHandleSubmit = this.handleSubmit.bind(this);
    this.boundHandleChange = this.handleChange.bind(this);
  }

  initialize(): void {
    // Form submissions
    document.addEventListener("submit", this.boundHandleSubmit, true);

    // Input/select/textarea change events
    document.addEventListener("change", this.boundHandleChange, true);
  }

  cleanup(): void {
    document.removeEventListener("submit", this.boundHandleSubmit, true);
    document.removeEventListener("change", this.boundHandleChange, true);
  }

  /**
   * L'autocapture amont produisait un événement inexploitable sur les
   * formulaires React (`<form onSubmit>` sans `id`, `name` ni `action`) :
   * `formId` et `formName` vides, et `formAction` valant l'URL de la PAGE —
   * une valeur qui a l'air renseignée et ne distingue pas deux formulaires.
   * `resolveFormIdentity` en tire une clé stable, ciblable par un objectif.
   *
   * On reste sur l'événement natif `form_submit`, émis au moment de la
   * soumission. Savoir si la demande est réellement PARTIE ne se devine pas
   * depuis le navigateur : c'est le serveur qui le sait, et c'est de là que
   * doit venir ce signal (la fonction serveur du site ne répond 200 que si
   * l'envoi a été accepté). Cf. le ticket sur l'issue des formulaires.
   */
  private handleSubmit(event: Event): void {
    const form = event.target as HTMLFormElement;
    if (form.tagName !== "FORM") return;

    const identity = resolveFormIdentity(form);

    const properties: FormSubmitProperties = {
      formId: identity.formId,
      formName: identity.formName,
      formAction: identity.formAction,
      method: (form.method || "get").toUpperCase(),
      fieldCount: form.elements.length,
      ariaLabel: form.getAttribute("aria-label") || undefined,
      formKey: identity.formKey,
      ...this.extractDataAttributes(form),
    };

    // Valeurs de champ : réglage par site, désactivé par défaut. Les exclusions
    // dures (mot de passe, champ caché, fichier, motifs bancaires) vivent dans
    // captureFormFields, jamais ici.
    if (this.config.trackFormFields) {
      Object.assign(properties, captureFormFields(form));
    }

    this.tracker.trackFormSubmit(properties);
  }

  private handleChange(event: Event): void {
    const target = event.target as HTMLElement;
    const tagName = target.tagName.toUpperCase();

    if (!["INPUT", "SELECT", "TEXTAREA"].includes(tagName)) return;

    // Skip disabled inputs
    if ((target as HTMLInputElement).disabled) return;

    // Skip readonly inputs since the user can't directly edit them
    // (e.g. fields computed from another input like a slider)
    if ((target as HTMLInputElement).readOnly) return;

    // Skip hidden inputs and password fields for privacy
    if (tagName === "INPUT") {
      const inputType = (target as HTMLInputElement).type?.toLowerCase();
      if (inputType === "hidden" || inputType === "password") return;
    }

    const inputName =
      (target as HTMLInputElement).name ||
      target.id ||
      target.getAttribute("aria-label") ||
      (target as HTMLInputElement).placeholder ||
      "";

    const properties: InputChangeProperties = {
      element: tagName.toLowerCase(),
      inputType: tagName === "INPUT" ? (target as HTMLInputElement).type?.toLowerCase() : undefined,
      inputName,
      formId: (target as HTMLInputElement).form?.id || undefined,
      formName: (target as HTMLInputElement).form?.name || undefined,
      ...this.extractDataAttributes(target),
    };

    this.tracker.trackInputChange(properties);
  }

  private extractDataAttributes(element: HTMLElement): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const attr of element.attributes) {
      if (attr.name.startsWith("data-rybbit-prop-")) {
        const key = attr.name.replace("data-rybbit-prop-", "");
        attrs[key] = attr.value;
      }
    }
    return attrs;
  }
}
