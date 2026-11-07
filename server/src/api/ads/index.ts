/**
 * Module Google Ads : conversions hors ligne (conception du 2026-08-29,
 * `todo/2026-08-29-conception-module-ads.md`).
 *
 * Barrel du dossier. Chaque lot ajoute SA ligne ici et ne touche pas celles des
 * autres : le dossier est écrit par plusieurs agents en parallèle et c'est le
 * seul fichier qu'ils partagent tous.
 *
 *   lot A  dataManager  client REST Data Manager
 *   lot C  attribution  retrouver l'identifiant de clic d'un utilisateur
 *   lot D  outbox       journal idempotent, drain, reprise
 *   lot E  settings     réglages par site + correspondances
 *   lot E  routes       routes HTTP et état de santé
 *   lot G  balayage     le déclencheur : événement mesuré → clic → journal
 *   lot H  couts        import des DÉPENSES depuis l'API Google Ads (lecture)
 *   lot I  trafic-paye  les visiteurs venus de la publicité, et ce qu'ils font
 */
export * from "./dataManager.js";
export * from "./attribution.js";
export * from "./outbox.js";
export * from "./settings.js";
export * from "./routes.js";
export * from "./balayage.js";
export * from "./couts.js";
export * from "./trafic-paye.js";
