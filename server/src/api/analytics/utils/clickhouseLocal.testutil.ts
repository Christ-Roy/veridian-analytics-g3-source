/**
 * Exécute pour de vrai le SQL que les constructeurs de requêtes produisent,
 * sans serveur ClickHouse, sans conteneur et sans toucher à une base réelle.
 *
 * Pourquoi ça existe : les ~110 tests d'entonnoirs et d'objectifs du dépôt
 * n'inspectent que la CHAÎNE SQL — sa syntaxe et son échappement. Aucun ne
 * prouve ce que ClickHouse RÉPOND. Or c'est là que vit la sémantique du
 * produit : l'ordre des étapes, le périmètre session, les taux, la division
 * par zéro. Un test qui lit du SQL passerait au vert sur une requête
 * parfaitement formée et sémantiquement fausse.
 *
 * `clickhouse local` est le vrai moteur, invoqué en un processus jetable qui
 * meurt avec la requête : rien n'écoute, rien ne persiste, rien ne survit à la
 * session.
 *
 * Le binaire est cherché dans $CLICKHOUSE_LOCAL_BIN, puis dans le PATH, puis
 * dans ~/.local/bin. Absent, {@link clickhouseLocalDisponible} rend false et
 * les suites qui en dépendent se déclarent explicitement non exécutées plutôt
 * que de passer au vert sans rien avoir prouvé.
 */
import { it } from "vitest";
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATS = [
  process.env.CLICKHOUSE_LOCAL_BIN,
  "/usr/bin/clickhouse",
  "/usr/local/bin/clickhouse",
  join(homedir(), ".local", "bin", "clickhouse"),
].filter((chemin): chemin is string => Boolean(chemin));

function executable(chemin: string): boolean {
  try {
    accessSync(chemin, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let binaireCache: string | null | undefined;

export function trouverClickhouseLocal(): string | null {
  if (binaireCache !== undefined) return binaireCache;

  for (const candidat of CANDIDATS) {
    if (executable(candidat)) {
      binaireCache = candidat;
      return candidat;
    }
  }

  const which = spawnSync("which", ["clickhouse"], { encoding: "utf8" });
  const trouve = which.status === 0 ? which.stdout.trim() : "";
  binaireCache = trouve && executable(trouve) ? trouve : null;
  return binaireCache;
}

export function clickhouseLocalDisponible(): boolean {
  return trouverClickhouseLocal() !== null;
}

/**
 * Une ligne de la table `events`, réduite aux colonnes que les requêtes
 * d'entonnoirs et d'objectifs lisent réellement. Les types sont ceux du schéma
 * de production (`db/clickhouse/schema/core.ts`) : `props` est un `JSON` et
 * `url_parameters` un `Map(String, String)`, parce que les conditions d'étape
 * les interrogent avec `JSONExtractString(toString(props), …)` et
 * `url_parameters[…]`, qui se comportent différemment sur un `String`.
 */
export type EvenementTest = {
  site_id?: number;
  /** Format `YYYY-MM-DD hh:mm:ss`. La colonne est un DateTime : résolution SECONDE. */
  timestamp: string;
  session_id: string;
  user_id?: string;
  hostname?: string;
  pathname?: string;
  url_parameters?: Record<string, string>;
  /** `pageview`, `custom_event`, `outbound`, `button_click`, `form_submit`, `copy`. */
  type?: string;
  event_name?: string;
  props?: Record<string, unknown>;
};

/**
 * Le sous-ensemble du schéma de production que les requêtes touchent. Engine
 * Memory : aucune écriture disque, la table meurt avec le processus.
 */
const DDL_EVENTS = `
CREATE TABLE events (
  site_id UInt16,
  timestamp DateTime,
  session_id String,
  user_id String,
  hostname String,
  pathname String,
  url_parameters Map(String, String),
  type LowCardinality(String) DEFAULT 'pageview',
  event_name String,
  props JSON,
  -- Colonnes que seul le détail des sessions d'une étape agrège. Elles n'ont
  -- pas d'entrée dans EvenementTest : les tests ne s'y intéressent pas, mais
  -- la requête les projette, et une colonne manquante ferait échouer
  -- l'exécution au lieu de mesurer la sémantique.
  identified_user_id String,
  country LowCardinality(FixedString(2)),
  region LowCardinality(String),
  city String,
  language LowCardinality(String),
  device_type LowCardinality(String),
  browser LowCardinality(String),
  browser_version LowCardinality(String),
  operating_system LowCardinality(String),
  operating_system_version LowCardinality(String),
  screen_width UInt16,
  screen_height UInt16,
  referrer String,
  channel String,
  page_title String,
  querystring String,
  tag LowCardinality(String),
  ip Nullable(String),
  lat Float64,
  lon Float64
) ENGINE = Memory;
`;

const chaine = (valeur: string) => `'${valeur.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const carte = (valeur: Record<string, string>) => {
  const paires = Object.entries(valeur).map(([cle, val]) => `${chaine(cle)}, ${chaine(val)}`);
  return paires.length === 0 ? "map()" : `map(${paires.join(", ")})`;
};

function ligneValues(evenement: EvenementTest): string {
  return [
    String(evenement.site_id ?? 1),
    chaine(evenement.timestamp),
    chaine(evenement.session_id),
    chaine(evenement.user_id ?? ""),
    chaine(evenement.hostname ?? "exemple.fr"),
    chaine(evenement.pathname ?? ""),
    carte(evenement.url_parameters ?? {}),
    chaine(evenement.type ?? "pageview"),
    chaine(evenement.event_name ?? ""),
    chaine(JSON.stringify(evenement.props ?? {})),
  ].join(", ");
}

/**
 * Charge `evenements` dans une table `events` neuve, y exécute `sql` et rend
 * les lignes du dernier SELECT.
 *
 * Toute erreur ClickHouse est relancée telle quelle : une requête qui ne
 * s'exécute pas ne doit jamais ressembler à une requête qui rend zéro ligne —
 * c'est exactement la confusion qu'un test de chaîne SQL ne peut pas lever.
 */
export function executerContreClickhouse<T = Record<string, unknown>>(options: {
  evenements: EvenementTest[];
  sql: string;
  params?: Record<string, string | number>;
}): T[] {
  const binaire = trouverClickhouseLocal();
  if (!binaire) {
    throw new Error(
      "Binaire `clickhouse` introuvable. Poser CLICKHOUSE_LOCAL_BIN, ou installer via `curl https://clickhouse.com/ | sh`."
    );
  }

  const insertion =
    options.evenements.length === 0
      ? ""
      : `INSERT INTO events (site_id, timestamp, session_id, user_id, hostname, pathname, url_parameters, type, event_name, props) VALUES ${options.evenements
          .map(evenement => `(${ligneValues(evenement)})`)
          .join(", ")};`;

  // `--output-format` et non `--format` : ce dernier s'applique AUSSI au
  // format d'entrée de l'INSERT, qui échoue alors à parser ses propres VALUES.
  // `session_timezone=UTC` n'est pas un détail : une colonne DateTime sans
  // fuseau interprète les chaînes insérées dans le fuseau de la SESSION. Sans
  // ce réglage, les mêmes tests donneraient des résultats différents selon le
  // fuseau de la machine qui les exécute, et un test de fenêtre temporelle
  // deviendrait un test du réglage de l'horloge du runner. UTC est aussi ce
  // que fait le conteneur ClickHouse de production.
  const arguments_ = ["local", "--output-format", "JSONEachRow", "--session_timezone", "UTC"];
  for (const [cle, valeur] of Object.entries(options.params ?? {})) {
    arguments_.push(`--param_${cle}=${String(valeur)}`);
  }
  arguments_.push("--query", `${DDL_EVENTS}\n${insertion}\n${options.sql}`);

  const resultat = spawnSync(binaire, arguments_, { encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });

  if (resultat.error) {
    throw new Error(`Lancement de clickhouse local impossible : ${resultat.error.message}`);
  }
  if (resultat.status !== 0) {
    throw new Error(`clickhouse local a échoué (code ${resultat.status}) :\n${resultat.stderr}`);
  }

  return resultat.stdout
    .split("\n")
    .filter(ligne => ligne.trim().length > 0)
    .map(ligne => JSON.parse(ligne) as T);
}

/**
 * Sentinelle : rendre IMPOSSIBLE un vert obtenu par saut silencieux.
 *
 * Les suites de sémantique se sautent quand le binaire manque. C'est un
 * compromis acceptable pour un poste de passage ou une contribution externe,
 * mais il produit alors **exactement le même vert** que si tout avait été
 * mesuré — et un `console.warn` se perd dans le bruit d'une sortie de test.
 * Personne ne peut donc distinguer « la sémantique est prouvée » de « la
 * sémantique n'a pas été regardée ».
 *
 * Cette fonction s'appelle dans un test TOUJOURS actif, hors des `describe`
 * conditionnels. Sous `CLICKHOUSE_LOCAL_REQUIRED=1` — à poser en intégration
 * continue — l'absence du binaire fait ÉCHOUER la suite au lieu de la sauter.
 * La garantie ne repose plus sur la vigilance de qui lance les tests, mais sur
 * la configuration.
 *
 * Le message nomme ce qui n'a PAS été vérifié, et non ce qui manque : le
 * lecteur doit comprendre ce qu'il perd, pas seulement qu'un fichier est absent.
 */
export function exigerMesureReelle(cequiNestPasVerifie: string): void {
  if (clickhouseLocalDisponible()) return;

  const exige = process.env.CLICKHOUSE_LOCAL_REQUIRED === "1";
  const message =
    `VÉRIFICATION ABSENTE — ${cequiNestPasVerifie} : rien n'a été mesuré par cette exécution. ` +
    "le binaire `clickhouse` est introuvable, les suites correspondantes ont été sautées. " +
    "Installer via `curl https://clickhouse.com/ | sh`, ou poser CLICKHOUSE_LOCAL_BIN.";

  if (exige) {
    throw new Error(
      `${message} CLICKHOUSE_LOCAL_REQUIRED=1 est posé : un saut n'est pas acceptable ici.`,
    );
  }
  console.warn(`⚠️  ${message}`);
}

/**
 * Déclare un test dont le TRAVAIL est fait à la collecte, et dont le `it` ne
 * porte plus que le verdict.
 *
 * 🔴 Pourquoi ce détour, mesuré le 31/08/2026 sur le runner auto-hébergé.
 *
 * Chaque appel à {@link executerContreClickhouse} lance un processus
 * `clickhouse local` jetable. Le chronométrage sépare nettement les deux coûts :
 *
 *   - lancer le binaire à vide (`SELECT 1`) : 0,17 s ;
 *   - lancer le binaire AVEC le DDL, l'insertion et la requête d'un test :
 *     0,19 s.
 *
 * Autrement dit, ~90 % du temps d'un test de sémantique est le démarrage d'un
 * binaire de plusieurs centaines de mégaoctets, et ~10 % seulement la requête,
 * qui est la seule chose que le test prétend mesurer. Ce coût fixe est celui
 * qui explose quand la machine est disputée : les mêmes tests passaient de
 * 0,3 s à 3 s selon la charge, sans qu'une ligne de SQL ait changé. C'est ce
 * qui avait fait poser `vi.setConfig({ testTimeout: 30_000 })` dans les trois
 * fichiers de sémantique — un délai qui ne corrige rien, il déplace juste le
 * seuil auquel la charge décide du verdict.
 *
 * Ici, le corps est exécuté pendant la COLLECTE, qui n'a pas de budget de
 * temps, et son éventuelle erreur est conservée puis relancée dans le `it`.
 * Trois propriétés sont donc préservées, et ce sont elles qui justifient de ne
 * pas simplement tout remonter dans le `describe` :
 *
 *   1. l'attribution : un échec reste nommé par SON test, avec le message et la
 *      pile d'origine — y compris un échec d'assertion ;
 *   2. le saut : sous `describe.skip` (binaire absent), le corps s'exécute mais
 *      son erreur n'est jamais relancée, donc rien ne rougit à tort ;
 *   3. la mesure : la requête est toujours réellement exécutée par ClickHouse,
 *      rien n'est simulé ni mis en cache.
 *
 * Le prix, assumé : filtrer par `-t` n'évite plus le travail des tests écartés,
 * puisqu'il est fait avant que le filtre s'applique.
 */
export function mesure(titre: string, corps: () => void): void {
  let echec: unknown;
  let aEchoue = false;
  try {
    corps();
  } catch (erreur) {
    echec = erreur;
    aEchoue = true;
  }
  it(titre, () => {
    if (aEchoue) throw echec;
  });
}
