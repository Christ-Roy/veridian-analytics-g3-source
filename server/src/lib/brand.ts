/**
 * Marque Veridian côté serveur — pendant de `client/src/lib/brand.ts`.
 *
 * Concerne tout ce qui sort de l'application vers un client : rapports PDF,
 * e-mails, conseils d'accueil, en-têtes envoyés à des tiers.
 *
 * ⚠️ Comme côté client, les identifiants TECHNIQUES gardent le nom amont et ne
 * doivent pas être touchés (`@rybbit/shared`, `window.rybbit`, noms de tables,
 * routes d'API).
 */
/**
 * URL publique de CETTE instance. Les e-mails transactionnels en ont besoin pour
 * produire des liens qui fonctionnent : upstream les codait en dur sur
 * app.rybbit.io, ce qui envoyait nos clients chez l'éditeur.
 */
const appUrl = (process.env.BASE_URL || "https://analytics.veridian.site").replace(/\/$/, "");

export const BRAND = {
  name: "Veridian Analytics",
  shortName: "Veridian",
  site: "https://veridian.site",
  docs: "https://veridian.site/docs/analytics",
  supportEmail: "contact@veridian.site",
  appUrl,
  /** Logo servi par cette instance, utilisable dans un e-mail HTML. */
  emailLogo: `${appUrl}/veridian/logo-horizontal.svg`,
} as const;
