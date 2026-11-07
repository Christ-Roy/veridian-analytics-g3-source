/**
 * Connexion automatique par le Hub (CONTRAT-HUB §6bis.8.0) : une page protégée visitée
 * sans session renvoie au Hub, qui ramène sur cette même page une fois connecté.
 *
 * Deux cookies locaux, posés côté navigateur, retiennent le rebond :
 *   - la déconnexion explicite : jamais de reconnexion silencieuse après un clic ;
 *   - le seul essai automatique : s'il n'a pas abouti, on montre la page de connexion, où
 *     le mot de passe reste possible pour un compte pas encore relié au Hub.
 * Tous deux tombent à la première connexion réussie.
 */
const LOGOUT_COOKIE = "veridian-logout";
const BOUNCE_TRY_COOKIE = "veridian-bounce-try";
const LOGOUT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const BOUNCE_TRY_MAX_AGE_SECONDS = 5 * 60;

/** Le Hub de cet environnement ; `null` hors plateforme Veridian : pas de rebond. */
export function hubBaseUrl(backendUrl: string | undefined): string | null {
  let host: string;
  try {
    host = new URL(backendUrl ?? "").hostname;
  } catch {
    return null;
  }
  if (host.endsWith(".staging.veridian.site")) {
    return "https://hub.staging.veridian.site";
  }
  return host.endsWith(".veridian.site") ? "https://app.veridian.site" : null;
}

export const HUB_URL = hubBaseUrl(process.env.NEXT_PUBLIC_BACKEND_URL);

/** Rebond vers le Hub. `auto` : essai silencieux, que le Hub plafonne de son côté. */
export function hubBounceUrl(hub: string, next: string, auto: boolean): string {
  const url = `${hub}/api/auth/bounce/prepare?next=${encodeURIComponent(next)}`;
  return auto ? `${url}&auto=1` : url;
}

/** L'adresse du bouton « Continuer » de la page de connexion, sans `auto`. */
export function hubContinueUrl(origin: string, hub: string | null = HUB_URL): string | null {
  return hub ? hubBounceUrl(hub, `${origin}/`, false) : null;
}

function readCookie(name: string): boolean {
  return document.cookie.split(";").some(cookie => cookie.trim().startsWith(`${name}=`));
}

function writeCookie(name: string, maxAge: number) {
  document.cookie = `${name}=1; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure`;
}

function clearCookie(name: string) {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

export function markExplicitLogout() {
  writeCookie(LOGOUT_COOKIE, LOGOUT_MAX_AGE_SECONDS);
}

export function clearBounceState() {
  clearCookie(LOGOUT_COOKIE);
  clearCookie(BOUNCE_TRY_COOKIE);
}

/**
 * L'adresse du rebond automatique, cet essai étant noté, ou `null` s'il ne faut pas
 * rebondir et afficher la page de connexion.
 */
export function startAutoBounce(location: string, hub: string | null = HUB_URL): string | null {
  const inIframe = window.self !== window.top;
  if (!hub || inIframe || readCookie(LOGOUT_COOKIE) || readCookie(BOUNCE_TRY_COOKIE)) {
    return null;
  }
  writeCookie(BOUNCE_TRY_COOKIE, BOUNCE_TRY_MAX_AGE_SECONDS);
  return hubBounceUrl(hub, location, true);
}
