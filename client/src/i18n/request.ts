import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

const SUPPORTED_LOCALES = ["en", "de", "fr", "zh", "es", "pl", "it", "ko", "pt", "ja", "cs", "uk"] as const;
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

function getLocaleFromAcceptLanguage(acceptLanguage: string): SupportedLocale {
  const languages = acceptLanguage
    .split(",")
    .map((part) => {
      const [lang, q] = part.trim().split(";q=");
      return { lang: lang.trim().split("-")[0].toLowerCase(), q: q ? parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { lang } of languages) {
    if (isSupportedLocale(lang)) {
      return lang;
    }
  }

  // Veridian : le repli est le FRANÇAIS, pas l'anglais. L'application est
  // commercialisée en France ; l'anglais n'est qu'un reste de l'amont, et ses
  // textes sources portent encore la marque de l'éditeur (ils servent de clés
  // d'extraction et ne peuvent pas être réécrits sans casser les 12 catalogues).
  return "fr";
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();

  let locale: SupportedLocale = "fr";

  // Priority 1: NEXT_LOCALE cookie (user's explicit choice)
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  if (cookieLocale && isSupportedLocale(cookieLocale)) {
    locale = cookieLocale;
  } else {
    // Priority 2: Accept-Language header (browser auto-detection)
    const acceptLanguage = headerStore.get("Accept-Language");
    if (acceptLanguage) {
      locale = getLocaleFromAcceptLanguage(acceptLanguage);
    }
  }

  return {
    locale,
    messages: await chargerMessages(locale),
  };
});

// Un libellé non traduit doit tomber en ANGLAIS, jamais en blanc.
// L'extracteur next-intl écrit une chaîne VIDE dans chaque catalogue pour toute
// clé qu'il vient de découvrir. next-intl rend alors cette chaîne vide telle
// quelle : pas d'erreur, pas de repli, un écran muet. C'est ainsi que la page
// Google Ads a été livrée entièrement blanche (110 clés vides d'un coup, dont
// son propre titre) et que trois entrées de menu n'avaient plus de libellé.
// On fusionne donc la source anglaise sous la traduction, en ignorant les
// valeurs vides de la cible.
async function chargerMessages(locale: SupportedLocale): Promise<Record<string, string>> {
  const source = (await import("../../messages/en.json")).default as Record<string, string>;
  if (locale === "en") return source;
  const cible = (await import(`../../messages/${locale}.json`)).default as Record<string, string>;
  const traduits = Object.fromEntries(Object.entries(cible).filter(([, valeur]) => valeur !== ""));
  return { ...source, ...traduits };
}
