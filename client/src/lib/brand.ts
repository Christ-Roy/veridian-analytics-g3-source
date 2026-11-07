/**
 * Marque Veridian — SOURCE UNIQUE.
 *
 * Tout ce qui est visible par un client (nom, logos, liens, e-mail) vient d'ici,
 * et de nulle part ailleurs. C'est ce qui rend le rebrand maintenable : à chaque
 * synchro avec l'upstream Rybbit, les conflits se limitent aux quelques lignes
 * qui référencent ce module, au lieu de se disperser dans 27 fichiers.
 *
 * ⚠️ NE PAS confondre avec les identifiants TECHNIQUES, qui gardent le nom
 * upstream et ne doivent JAMAIS être renommés :
 *   - `window.rybbit` et son API (`init`, `event`, `flag`, `identify`) — c'est le
 *     contrat public du tracker, déjà posé sur les sites clients ; le renommer
 *     casserait tous les snippets en production ;
 *   - les paquets `@rybbit/shared` et `@rybbit/react` ;
 *   - les noms de tables, de colonnes et de routes d'API.
 *
 * Le contrôle `scripts/check-brand.sh` fait respecter cette frontière en CI.
 */

export const BRAND = {
  /** Nom complet, pour les titres et les phrases. */
  name: "Veridian Analytics",
  /** Nom court, quand la place manque ou dans une phrase déjà contextualisée. */
  shortName: "Veridian",
  /** Baseline affichée sous le logo sur les écrans d'authentification. */
  tagline: "Analyse d'audience, sans cookie et hébergée en France",

  logo: {
    /** Icône seule (favicon, sidebar repliée, pastilles). */
    mark: "/veridian/mark.svg",
    /** Logo complet avec le nom. */
    horizontal: "/veridian/logo-horizontal.svg",
    /** Ratio du logo horizontal, pour calculer une hauteur à partir d'une largeur. */
    horizontalAspectRatio: 420 / 96,
  },

  urls: {
    site: "https://veridian.site",
    /** Documentation destinée au client final. */
    docs: "https://veridian.site/docs/analytics",
    /** Où un client demande de l'aide. */
    support: "mailto:contact@veridian.site",
  },

  supportEmail: "contact@veridian.site",

  /**
   * Coupe d'un seul geste toute la promotion de l'éditeur amont : parrainage
   * GitHub, Discord, X, programme d'affiliation, liens vers rybbit.com, mentions
   * légales de l'éditeur, « Made with ❤️ by frogs ».
   *
   * Laisser à `false`. Ce drapeau existe pour que la suppression soit explicite
   * et réversible, plutôt que dispersée en suppressions de code impossibles à
   * rejouer après un merge.
   */
  showUpstreamPromotion: false,

  /**
   * L'AGPL-3.0 impose de proposer la source aux utilisateurs servis par le
   * réseau. On assume le fork : le lien reste, discret, dans le pied de page.
   */
  sourceUrl: "https://github.com/rybbit-io/rybbit",
} as const;

/** Année courante, pour la mention de copyright. */
export const brandYear = () => new Date().getFullYear();
