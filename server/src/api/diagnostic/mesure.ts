/**
 * Diagnostic de mesure d'un site : « ce que ce site envoie est-il exploitable ? »
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 POURQUOI CE MODULE N'EST PAS DANS `api/ads/`
 *
 * `ads/settings.ts` porte déjà `etatSante()`. Les deux ne répondent PAS à la
 * même question et les confondre serait une erreur d'architecture :
 *
 *   - `etatSante` regarde l'AVAL — le journal d'envoi, le drain, le dernier
 *     balayage. Il répond « ce que j'ai capté part-il bien chez Google ? » ;
 *   - ce module regarde l'AMONT — ce que le NAVIGATEUR du client envoie
 *     réellement. Il répond « y a-t-il seulement quelque chose à envoyer ? ».
 *
 * Un site peut avoir un aval parfait (zéro erreur, zéro retard) et un amont
 * vide : c'est exactement l'état d'ASD le 2026-08-29, et c'est l'état qui ne
 * lève rien nulle part. Surtout, la majorité des clients de la plateforme n'ont
 * PAS de compte Google Ads, et leur mesure doit se diagnostiquer quand même.
 * Enterrer l'outil sous `/ads/` le rendrait invisible pour eux.
 *
 * La publicité n'est donc ici qu'une SECTION du diagnostic, alimentée par les
 * correspondances quand elles existent, muette sinon.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 LA RÈGLE QUI GOUVERNE TOUT LE FICHIER
 *
 * Chaque constat porte une `certitude`, et elle n'est pas décorative :
 *
 *   - `mesure`      : la donnée dit non. « 340 ajouts au panier, 0 commande. »
 *   - `indetermine` : je n'ai pas la donnée. « 3 ajouts au panier sur 30 jours :
 *                     aucun ratio n'est concluant à ce volume. »
 *
 * C'est le défaut qu'on traque : un système qui rend « 0 » pour dire à la fois
 * « c'est cassé » et « je n'ai pas regardé ». Aucun constat de ce fichier ne
 * peut être écrit sans choisir explicitement entre les deux.
 *
 * Corollaire : quand la période ne contient RIEN, le diagnostic ne rend pas un
 * verdict rassurant et ne rend pas non plus une liste d'alarmes. Il rend
 * `pas_de_donnees` et se tait sur le reste — un site muet n'a pas de tunnel
 * cassé, il n'a pas de tunnel du tout.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Fonction PURE : aucune base, aucun Fastify. Motif du dépôt (`classerBalayage`
 * dans `ads/settings.ts`, `buildUserInfoQueries` dans `analytics/users/`). La
 * couche qui va chercher les chiffres vit dans `collecte.ts`.
 */

/* ─────────────────────────────── Les entrées ────────────────────────────── */

/** Statistiques d'UN nom d'événement sur la période. Tout vient de ClickHouse. */
export interface StatistiquesEvenement {
  nom: string;
  /** Occurrences. */
  total: number;
  /** Sessions distinctes qui l'ont émis. Sert à repérer un événement en boucle. */
  sessions: number;

  /** Occurrences portant une clé de valeur monétaire ET une valeur numérique. */
  avecValeur: number;
  /** Occurrences portant une clé de valeur dont le contenu n'est PAS un nombre. */
  valeurNonNumerique: number;
  /** Occurrences portant un identifiant métier (déduplication possible). */
  avecIdentifiant: number;
  /** Occurrences portant le signal de consentement publicitaire. */
  avecConsentement: number;

  /** Bornes de la valeur numérique lue. `null` quand aucune n'a été lue. */
  valeurMin: number | null;
  valeurMax: number | null;
  valeurMediane: number | null;

  /**
   * Occurrences dont les `props` frôlent la limite d'ingestion (2048 octets).
   *
   * 🔴 Ce compteur ne dit PAS combien d'événements ont été rejetés : ceux-là
   * n'existent nulle part, la validation les écarte avant l'écriture. Il dit
   * qu'on s'en approche, donc que d'autres sont peut-être tombés. Tout constat
   * qui en découle est `indetermine`, jamais `mesure`.
   */
  propsPresqueLongues: number;
  /** Taille maximale de `props` observée, en octets. */
  propsTailleMax: number;
}

/** Une correspondance Google Ads configurée pour le site. */
export interface CorrespondanceConnue {
  eventName: string;
  conversionActionId: string;
}

export interface EntreesDiagnostic {
  siteId: number;
  /** Bornes ISO de la fenêtre observée, telles qu'interrogées. */
  periode: { debut: string; fin: string; jours: number };

  /** Pages vues (`type = 'pageview'`). Le traceur de base est-il seulement posé ? */
  pagesVues: number;
  /** Un agrégat par nom d'événement personnalisé. Les pages vues n'y sont pas. */
  evenements: StatistiquesEvenement[];
  /** Noms d'événements distincts sur la période (limite de la plateforme : 1000). */
  nomsDistincts: number;

  /**
   * TOUTES les lignes reçues sur la période, pages vues comprises.
   *
   * 🔴 Il est lu à la source et non reconstitué en additionnant les pages vues
   * et le détail par événement : ce détail est BORNÉ aux noms les plus fréquents.
   * Sur un site à deux cents noms, la somme serait inférieure à la réalité, donc
   * la part de trafic de centre de données serait SURÉVALUÉE, et l'alerte
   * partirait sur un site sain. Un dénominateur tronqué est une des façons les
   * plus discrètes de fabriquer une alarme permanente.
   */
  totalLignes: number;
  /** Lignes reçues dont l'ASN est un centre de données. */
  traficDatacenter: number;
  /**
   * Lignes écartées comme robots.
   *
   * `null` signifie « je n'ai pas la donnée » (table absente, requête en échec)
   * et se propage jusqu'au rapport : il ne devient JAMAIS zéro.
   */
  traficRobot: number | null;

  /** Correspondances Ads configurées. Tableau vide = aucune. */
  correspondances: CorrespondanceConnue[];
  /** `null` = le site n'a aucun réglage Ads ; c'est le cas normal, pas un défaut. */
  adsActif: boolean | null;
}

/* ─────────────────────────────── Les sorties ────────────────────────────── */

export type GraviteConstat = "critique" | "avertissement" | "information";

/**
 * `mesure` : la donnée permet de conclure. `indetermine` : elle ne le permet
 * pas, et le constat existe pour dire précisément CE QUI MANQUE.
 */
export type CertitudeConstat = "mesure" | "indetermine";

export interface Constat {
  /** Code stable, destiné au code appelant et aux tests. Jamais traduit. */
  code: string;
  gravite: GraviteConstat;
  certitude: CertitudeConstat;
  /** Une phrase CHIFFRÉE. « 0 commande » est interdit ; « 340 paniers, 0 commande » convient. */
  titre: string;
  /** Ce que ça implique. */
  detail: string;
  /** Ce qu'il faut faire. Un constat sans action est un constat inutile. */
  action: string;
  /** Les chiffres bruts, pour l'interface et pour les tests. */
  preuve: Record<string, unknown>;
}

/**
 * `pas_de_donnees` n'est ni bon ni mauvais : c'est l'aveu que la période
 * n'autorise aucun verdict. Il ne se confond ni avec `sain` ni avec `casse`.
 */
export type VerdictMesure = "pas_de_donnees" | "sain" | "a_corriger" | "casse";

export interface EtapeObservee {
  /** Nom canonique de l'étape (`ajout_panier`…). */
  etape: string;
  /** Le nom d'événement RÉELLEMENT émis qui l'a incarnée, ou `null` si absente. */
  nomEmis: string | null;
  occurrences: number;
}

export interface RapportDiagnostic {
  siteId: number;
  periode: { debut: string; fin: string; jours: number };
  verdict: VerdictMesure;
  /** Une phrase chiffrée qui résume tout, destinée à être lue seule. */
  resume: string;
  constats: Constat[];
  observe: {
    pagesVues: number;
    evenementsMetier: number;
    nomsDistincts: number;
    tunnel: EtapeObservee[];
  };
}

/* ──────────────────────────────── Les seuils ────────────────────────────── */

/**
 * 🔴 AUCUN seuil de cette section n'est MESURÉ. Ils sont tous CHOISIS, à la
 * conception, sans jeu de données de référence — la plateforme n'en a pas
 * encore, puisque c'est ce module qui va en produire.
 *
 * C'est écrit ici parce qu'un chiffre arbitraire assumé ne pose aucun problème,
 * alors qu'un chiffre arbitraire qui a l'air établi en pose un gros : personne
 * n'ose plus le déplacer, et il finit par décider seul de ce qui est une alerte.
 * Chaque constante porte donc le RAISONNEMENT qui l'a fixée, pas une autorité
 * qu'elle n'a pas.
 *
 * Ce qui les rendra mesurés : passer le diagnostic sur les sites réels de la
 * plateforme et regarder la distribution des constats. Un seuil qui alerte sur
 * la moitié des sites sains est trop bas ; un seuil qui n'alerte jamais est
 * décoratif. Les déplacer est attendu, pas exceptionnel.
 */

/**
 * En deçà de ce volume sur l'étape AMONT, aucun ratio de tunnel n'est
 * concluant : trois paniers sans commande, c'est une journée normale.
 *
 * 🔴 Ce seuil est la différence entre un diagnostic et une alarme permanente.
 * Sans lui, tout site neuf hurlerait « tunnel cassé » dès son premier visiteur,
 * et l'outil serait ignoré au bout d'une semaine — donc inutile le jour où il
 * aurait raison.
 *
 * ⚠️ 30 est CHOISI, pas mesuré. Le raisonnement : à ce volume, un tunnel qui
 * convertit à 3 % produit environ une conversion, donc zéro reste banal ; à 300
 * il en produirait dix, et zéro devient une anomalie. 30 est le point où
 * l'absence commence à vouloir dire quelque chose, sans faire attendre un mois
 * un site qui démarre. Aucune distribution réelle ne l'a validé.
 */
export const VOLUME_MINIMAL_CONCLUANT = 30;

/**
 * Sous ce taux de passage entre deux étapes CONSÉCUTIVES et peuplées, on parle
 * de chute invraisemblable. 0,5 % est très bas à dessein : un tunnel e-commerce
 * médiocre convertit à 1 %, un tunnel cassé à 0.
 *
 * ⚠️ CHOISI, pas mesuré. Il est délibérément placé sous le pire taux plausible
 * plutôt qu'au milieu de la distribution : ce constat doit attraper une panne,
 * jamais juger une performance commerciale. Un site qui vend mal n'est pas un
 * site mal mesuré, et le confondre ferait du diagnostic un donneur de leçons.
 */
export const TAUX_PLANCHER_ETAPE = 0.005;

/**
 * Part de trafic issu de centres de données au-delà de laquelle on alerte.
 *
 * ⚠️ CHOISI. 20 % est le point où le trafic automatisé cesse d'être du bruit et
 * commence à fausser visiblement les taux : un cinquième du dénominateur, c'est
 * un taux de conversion sous-estimé d'un quart.
 */
export const PART_DATACENTER_ALERTE = 0.2;

/** Limite de la plateforme sur le nombre de noms d'événements distincts. */
export const LIMITE_NOMS_EVENEMENTS = 1000;
/**
 * Palier d'alerte avant la limite : il reste alors de quoi réagir.
 *
 * ⚠️ CHOISI. 80 % de la limite laisse 200 noms de marge, soit largement le temps
 * de voir venir. La limite de 1000, elle, n'est pas choisie : c'est celle de la
 * plateforme.
 */
export const SEUIL_NOMS_EVENEMENTS = 800;

/**
 * Bornes de plausibilité de la MÉDIANE d'une valeur de conversion, en unité
 * monétaire principale.
 *
 * Elles ne jugent pas le prix du client : elles attrapent les deux erreurs
 * d'unité qui ne se voient jamais autrement. Une médiane à 4 990 dit « des
 * centimes envoyés comme des unités » (le panier vaut 49,90 €, la régie
 * encaisse 4 990 € de valeur de conversion, et le retour sur dépense affiché
 * est faux d'un facteur cent). Une médiane à 0,02 dit l'inverse.
 *
 * 🔴 Le plafond est à 2 000 et NON à 5 000, précisément pour attraper ce
 * cas-là : un panier de 49,90 € envoyé en centimes vaut 4 990, qu'un plafond à
 * 5 000 laisserait passer de justesse. Le prix est assumé : un site dont le
 * panier médian dépasse réellement 2 000 € (mobilier, B2B) recevra un
 * avertissement infondé. C'est un AVERTISSEMENT, pas un blocage, et il nomme
 * l'unité attendue — un lecteur tranche en dix secondes. L'erreur inverse, un
 * facteur cent sur toute la valeur de conversion, ne se voit jamais.
 */
export const MEDIANE_PLAUSIBLE_MIN = 0.5;
export const MEDIANE_PLAUSIBLE_MAX = 2000;

/**
 * Les constats qui signifient « je n'ai pas de quoi me prononcer sur le tunnel ».
 *
 * 🔴 Ils INTERDISENT le verdict `sain`, et c'est le point le plus important du
 * fichier. Un site avec trois ajouts au panier et zéro commande ne déclenche
 * aucune alerte — à ce volume, l'absence de commande s'explique aussi bien par
 * un défaut de mesure que par l'absence d'acheteurs, et alerter fabriquerait
 * l'alarme permanente qu'on cherche à éviter. Mais rendre `sain` reviendrait à
 * répondre « tout va bien » à une question qu'on n'a pas su instruire : c'est
 * exactement le défaut que ce module existe pour attraper, reproduit par le
 * module lui-même. D'où un TROISIÈME état, `pas_de_donnees`, qui n'est ni bon ni
 * mauvais et qui dit ce qu'il manque pour trancher.
 *
 * La liste est volontairement CLOSE et ne contient que les constats portant sur
 * le tunnel. `trafic_robot_inconnu` est aussi `indetermine` mais n'y figure pas :
 * ignorer la part de robots n'empêche pas de juger si une commande porte un
 * montant. Basculer tout un rapport sur cette seule lacune le rendrait
 * inexploitable dès qu'une table est indisponible.
 */
const CODES_NON_CONCLUANTS = new Set(["aucune_donnee", "volume_insuffisant"]);

/**
 * Sous ce taux de couverture, une propriété est « partiellement » présente.
 *
 * ⚠️ CHOISIS. L'identifiant est le plus exigeant (95 %) parce que son absence
 * coûte une conversion comptée DEUX FOIS, alors qu'un montant manquant n'en
 * coûte qu'une mal valorisée. Les 5 et 10 % de tolérance existent pour absorber
 * les cas limites normaux (une commande sans montant faute de stock, un
 * consentement encore inconnu au premier chargement) sans crier.
 */
export const COUVERTURE_ATTENDUE_VALEUR = 0.9;
export const COUVERTURE_ATTENDUE_IDENTIFIANT = 0.95;
export const COUVERTURE_ATTENDUE_CONSENTEMENT = 0.9;

/* ──────────────────────────────── Le tunnel ─────────────────────────────── */

/**
 * Les étapes canoniques d'un tunnel d'achat, DE L'AMONT VERS L'AVAL, chacune
 * avec les noms d'événements qui l'incarnent.
 *
 * 🔴 Liste FERMÉE, comme `CLES_IDENTIFIANT_METIER` dans `ads/balayage.ts`, et
 * pour la même raison : deviner qu'un nom « ressemble à » une étape ferait
 * changer le diagnostic le jour où le client renomme un événement, sans que
 * personne ne comprenne pourquoi l'alerte est apparue ou a disparu.
 *
 * Les alias couvrent les deux conventions rencontrées en clientèle : celle
 * d'ASD (`cart_item_added`) et celle de Google Analytics 4 (`add_to_cart`), que
 * beaucoup de sites ont conservée en migrant.
 */
export const ETAPES_TUNNEL: ReadonlyArray<{ etape: string; libelle: string; noms: readonly string[] }> = [
  { etape: "vue_produit", libelle: "fiche produit vue", noms: ["product_viewed", "view_item", "product_view"] },
  { etape: "ajout_panier", libelle: "ajout au panier", noms: ["cart_item_added", "add_to_cart"] },
  { etape: "panier_vu", libelle: "panier consulté", noms: ["cart_viewed", "view_cart"] },
  { etape: "checkout", libelle: "commande entamée", noms: ["checkout_started", "begin_checkout"] },
  { etape: "paiement", libelle: "paiement lancé", noms: ["payment_initiated", "add_payment_info"] },
  {
    etape: "achat",
    libelle: "commande payée",
    noms: ["order_confirmed", "order_paid", "order_completed", "purchase", "subscription_activated"],
  },
];

/** Les noms d'événements qui valent conversion, quels que soient les réglages Ads. */
const NOMS_ACHAT = new Set(ETAPES_TUNNEL[ETAPES_TUNNEL.length - 1]!.noms);

/* ─────────────────────────────── Utilitaires ────────────────────────────── */

function pourcent(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 10;
}

/**
 * Distance d'édition bornée, pour suggérer le nom réellement émis quand une
 * correspondance vise un nom absent. Une faute de frappe sur `order_paid` /
 * `order_confirmed` est la panne la plus banale du module et la plus muette :
 * le balayage ne demande que les noms mappés, donc il ne lit rien, donc tous ses
 * compteurs valent zéro et l'écran est celui d'un site sans trafic.
 */
function proche(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 12) return 99;
  let precedente = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const courante = [i];
    for (let j = 1; j <= n; j++) {
      courante[j] = Math.min(
        precedente[j]! + 1,
        courante[j - 1]! + 1,
        precedente[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    precedente = courante;
  }
  return precedente[n]!;
}

/** La famille d'un nom d'événement : ce qui précède le premier `_`. */
function famille(nom: string): string {
  const coupe = nom.indexOf("_");
  return coupe === -1 ? nom : nom.slice(0, coupe);
}

/**
 * Le nom émis le plus proche d'un nom attendu, s'il constitue une piste.
 *
 * 🔴 Deux heuristiques, et la SECONDE est celle qui compte. La distance
 * d'édition seule ratait le cas réel qui a motivé ce constat :
 * `order_paid` → `order_confirmed` sont à neuf éditions l'un de l'autre, très
 * au-delà d'une faute de frappe, et pourtant c'est bien le même événement sous
 * deux noms. Ce que ces deux-là partagent n'est pas leur orthographe, c'est leur
 * FAMILLE (`order`). On cherche donc d'abord dans la famille, et on ne retombe
 * sur la distance d'édition que pour les noms sans famille commune.
 *
 * Le risque assumé : `order_confirmed` et `order_refunded` sont de la même
 * famille, donc une correspondance visant un `order_*` inexistant pourrait se
 * voir proposer le remboursement. C'est acceptable — le constat AFFIRME que le
 * nom visé n'existe pas (c'est mesuré) et ne fait que SUGGÉRER le remplaçant,
 * en le nommant explicitement pour que le lecteur tranche.
 */
function suggerer(attendu: string, emis: readonly string[]): string | null {
  const memeFamille = emis.filter(nom => famille(nom) === famille(attendu));
  const candidats = memeFamille.length > 0 ? memeFamille : emis;

  let meilleur: string | null = null;
  let score = 99;
  for (const nom of candidats) {
    const d = proche(attendu, nom);
    if (d < score) {
      score = d;
      meilleur = nom;
    }
  }

  if (meilleur === null) return null;
  // Dans la famille, on fait confiance au préfixe partagé. Hors famille, il faut
  // que ce soit une vraie faute de frappe : au-delà de la moitié du nom, c'est un
  // autre événement, et suggérer ferait plus de mal que se taire.
  if (memeFamille.length > 0) return meilleur;
  return score <= Math.max(3, Math.floor(attendu.length / 2)) ? meilleur : null;
}

/* ─────────────────────────────── Le diagnostic ──────────────────────────── */

/**
 * Rend le verdict complet. PURE : deux appels sur les mêmes entrées rendent le
 * même rapport, et aucun test n'a besoin d'une base pour l'exercer.
 */
export function diagnostiquerMesure(entrees: EntreesDiagnostic): RapportDiagnostic {
  const constats: Constat[] = [];
  const parNom = new Map(entrees.evenements.map(e => [e.nom, e]));
  const nomsEmis = entrees.evenements.map(e => e.nom);
  const totalEvenements = entrees.evenements.reduce((s, e) => s + e.total, 0);

  // Le tunnel observé sert au rapport MÊME quand il est vide : l'interface doit
  // pouvoir montrer « cette étape n'existe pas » et pas seulement « 0 ».
  const tunnel: EtapeObservee[] = ETAPES_TUNNEL.map(({ etape, noms }) => {
    // Une étape peut être incarnée par plusieurs noms (ASD émet `order_confirmed`
    // ET `subscription_activated`) : on additionne, et on nomme le plus fréquent.
    const presents = noms.map(n => parNom.get(n)).filter((s): s is StatistiquesEvenement => s !== undefined);
    const occurrences = presents.reduce((s, e) => s + e.total, 0);
    const dominant = presents.sort((a, b) => b.total - a.total)[0];
    return { etape, nomEmis: dominant?.nom ?? null, occurrences };
  });

  const observe = {
    pagesVues: entrees.pagesVues,
    evenementsMetier: totalEvenements,
    nomsDistincts: entrees.nomsDistincts,
    tunnel,
  };

  /* ── 1. Rien du tout : on le dit, et on s'arrête là ────────────────────── */

  if (entrees.pagesVues === 0 && totalEvenements === 0) {
    constats.push({
      code: "aucune_donnee",
      gravite: "critique",
      certitude: "indetermine",
      titre: `Aucune donnée reçue sur ${entrees.periode.jours} jours : ni page vue, ni événement.`,
      detail:
        "Le diagnostic ne peut rien conclure sur la qualité de la mesure — il n'y a rien à examiner. " +
        "Soit le traceur n'est pas installé, soit il est bloqué (bloqueur de publicité, en-tête de sécurité, " +
        "identifiant de site erroné), soit le site n'a reçu aucune visite sur la période.",
      action:
        "Ouvrir le site et vérifier dans l'onglet réseau du navigateur qu'une requête part bien vers le traceur, " +
        "puis élargir la période avant de conclure.",
      preuve: { jours: entrees.periode.jours, pagesVues: 0, evenements: 0 },
    });
    return {
      siteId: entrees.siteId,
      periode: entrees.periode,
      verdict: "pas_de_donnees",
      resume: `Aucune donnée sur ${entrees.periode.jours} jours. Rien ne permet de juger la mesure.`,
      constats,
      observe,
    };
  }

  /* ── 2. Le site est-il instrumenté au-delà des pages vues ? ────────────── */

  if (totalEvenements === 0) {
    constats.push({
      code: "aucun_evenement_metier",
      gravite: "critique",
      certitude: "mesure",
      titre: `${entrees.pagesVues} pages vues et aucun événement métier sur ${entrees.periode.jours} jours.`,
      detail:
        "Seul le traceur de base est posé. Aucune conversion ne peut être mesurée, ni envoyée à une régie : " +
        "il n'y a rien à envoyer. Ce n'est pas un site calme, c'est un site non instrumenté.",
      action:
        "Poser les appels d'événements du tunnel sur le site (ajout au panier, commande entamée, commande payée) " +
        "avant toute campagne payante.",
      preuve: { pagesVues: entrees.pagesVues, evenements: 0 },
    });
  }

  /* ── 3. Les ruptures du tunnel ─────────────────────────────────────────── */

  constats.push(...diagnostiquerTunnel(tunnel, entrees.periode.jours));

  /* ── 4. La qualité des propriétés, sur les événements qui comptent ─────── */

  // Ne sont examinés que les événements qui portent une conversion : un
  // `product_viewed` sans montant n'est pas un défaut, c'est une fiche produit.
  const nomsMappes = new Set(entrees.correspondances.map(c => c.eventName));
  const aConversionAds = nomsMappes.size > 0;
  const evenementsDeConversion = entrees.evenements.filter(e => nomsMappes.has(e.nom) || NOMS_ACHAT.has(e.nom));

  for (const evenement of evenementsDeConversion) {
    constats.push(...diagnostiquerProprietes(evenement, { consentementAttendu: aConversionAds || entrees.adsActif === true }));
  }

  /* ── 5. La cohérence avec la configuration Google Ads ──────────────────── */

  constats.push(...diagnostiquerCorrespondances(entrees, nomsEmis, parNom));

  /* ── 6. Les signaux d'alerte ───────────────────────────────────────────── */

  constats.push(...diagnostiquerSignaux(entrees));

  /* ── 7. Le verdict ─────────────────────────────────────────────────────── */

  const critiques = constats.filter(c => c.gravite === "critique").length;
  const avertissements = constats.filter(c => c.gravite === "avertissement").length;
  const nonConcluants = constats.filter(c => CODES_NON_CONCLUANTS.has(c.code)).length;

  // 🔴 L'ordre compte, et la dernière branche est celle qui a coûté cher ailleurs :
  // un site dont le tunnel n'a PAS assez de volume pour être jugé ne rend pas
  // « sain ». Rien n'a été prouvé sain — on n'a simplement pas pu conclure, et
  // c'est un troisième état, pas une bonne nouvelle.
  const verdict: VerdictMesure =
    critiques > 0 ? "casse" : avertissements > 0 ? "a_corriger" : nonConcluants > 0 ? "pas_de_donnees" : "sain";

  return {
    siteId: entrees.siteId,
    periode: entrees.periode,
    verdict,
    resume: resumer(verdict, entrees, totalEvenements, critiques, avertissements),
    constats,
    observe,
  };
}

function resumer(
  verdict: VerdictMesure,
  entrees: EntreesDiagnostic,
  totalEvenements: number,
  critiques: number,
  avertissements: number
): string {
  const socle =
    `${entrees.pagesVues} pages vues, ${totalEvenements} événements métier ` +
    `sur ${entrees.nomsDistincts} noms distincts, en ${entrees.periode.jours} jours`;
  if (verdict === "sain") return `${socle} : mesure exploitable, aucun défaut relevé.`;
  if (verdict === "casse") return `${socle} : ${critiques} défaut(s) bloquant(s) relevé(s).`;
  if (verdict === "a_corriger") return `${socle} : ${avertissements} point(s) à corriger, rien de bloquant.`;
  // `pas_de_donnees` hors du vide total : aucun défaut relevé, mais le volume ne
  // permet pas d'en conclure qu'il n'y en a pas. La phrase doit dire les deux.
  return `${socle} : aucun défaut relevé, mais le volume ne permet pas de conclure que la mesure est juste.`;
}

/* ───────────────────────────── Règles : tunnel ──────────────────────────── */

/**
 * Compare chaque étape peuplée à la suivante qui EXISTE.
 *
 * 🔴 On ne compare jamais à une étape absente du site. Beaucoup de tunnels
 * n'ont pas de « panier consulté » (achat en un clic) ; l'absence d'une étape
 * intermédiaire n'est pas un défaut, elle est un choix produit. Ce qui est un
 * défaut, c'est qu'une étape peuplée ne débouche sur RIEN en aval.
 */
function diagnostiquerTunnel(tunnel: EtapeObservee[], jours: number): Constat[] {
  const constats: Constat[] = [];
  const libelles = new Map(ETAPES_TUNNEL.map(e => [e.etape, e.libelle]));
  const peuplees = tunnel.filter(e => e.occurrences > 0);
  if (peuplees.length === 0) return constats;

  const derniereEtapePeuplee = peuplees[peuplees.length - 1]!;
  const indexDerniere = tunnel.findIndex(e => e.etape === derniereEtapePeuplee.etape);
  const etapesAval = tunnel.slice(indexDerniere + 1);

  // Cas 1 — le tunnel s'arrête net. Rien en aval de la dernière étape peuplée.
  if (etapesAval.length > 0) {
    const amont = derniereEtapePeuplee.occurrences;
    const manquantes = etapesAval.map(e => libelles.get(e.etape) ?? e.etape);
    if (amont >= VOLUME_MINIMAL_CONCLUANT) {
      constats.push({
        code: "rupture_tunnel",
        gravite: "critique",
        certitude: "mesure",
        titre:
          `${amont} « ${libelles.get(derniereEtapePeuplee.etape)} » et AUCUN événement en aval ` +
          `sur ${jours} jours (${manquantes.join(", ")} : jamais émis).`,
        detail:
          "Le tunnel est mesuré jusqu'à cette étape et plus du tout ensuite. Deux explications, et une seule " +
          "est visible ici : soit les appels d'événements en aval n'ont pas été posés, soit ils échouent. " +
          "Personne ne peut savoir si le site vend.",
        action:
          `Poser ou réparer l'événement « ${manquantes[manquantes.length - 1]} », puis passer une commande de bout ` +
          "en bout et vérifier qu'elle apparaît dans les événements.",
        preuve: {
          derniereEtape: derniereEtapePeuplee.etape,
          nomEmis: derniereEtapePeuplee.nomEmis,
          occurrences: amont,
          etapesManquantes: etapesAval.map(e => e.etape),
        },
      });
    } else {
      constats.push({
        code: "volume_insuffisant",
        gravite: "information",
        certitude: "indetermine",
        titre:
          `${amont} « ${libelles.get(derniereEtapePeuplee.etape)} » sur ${jours} jours : ` +
          `trop peu pour conclure quoi que ce soit sur la suite du tunnel.`,
        detail:
          `En dessous de ${VOLUME_MINIMAL_CONCLUANT} occurrences, une absence en aval s'explique aussi bien ` +
          "par un défaut de mesure que par l'absence d'acheteurs. Le diagnostic refuse de trancher.",
        action: "Élargir la période, ou repasser ce diagnostic quand le trafic aura monté.",
        preuve: { etape: derniereEtapePeuplee.etape, occurrences: amont, seuil: VOLUME_MINIMAL_CONCLUANT },
      });
    }
  }

  // Cas 2 — deux étapes peuplées consécutives dont le passage est invraisemblable.
  for (let i = 0; i < peuplees.length - 1; i++) {
    const amont = peuplees[i]!;
    const aval = peuplees[i + 1]!;
    if (amont.occurrences < VOLUME_MINIMAL_CONCLUANT) continue;
    const taux = aval.occurrences / amont.occurrences;
    if (taux >= TAUX_PLANCHER_ETAPE) continue;
    constats.push({
      code: "chute_tunnel",
      gravite: "avertissement",
      certitude: "mesure",
      titre:
        `${amont.occurrences} « ${libelles.get(amont.etape)} » pour ${aval.occurrences} ` +
        `« ${libelles.get(aval.etape)} » (${(taux * 100).toFixed(2)} %).`,
      detail:
        `Un passage sous ${(TAUX_PLANCHER_ETAPE * 100).toFixed(1)} % entre deux étapes voisines s'explique ` +
        "rarement par le comportement des visiteurs : le plus souvent, l'événement aval n'est émis que sur " +
        "un chemin particulier (un seul mode de livraison, un seul moyen de paiement) et rate les autres.",
      action: "Rejouer le parcours par chaque chemin possible et vérifier que l'événement aval part à chaque fois.",
      preuve: {
        amont: { etape: amont.etape, nomEmis: amont.nomEmis, occurrences: amont.occurrences },
        aval: { etape: aval.etape, nomEmis: aval.nomEmis, occurrences: aval.occurrences },
        taux,
      },
    });
  }

  return constats;
}

/* ──────────────────────── Règles : qualité des props ────────────────────── */

function diagnostiquerProprietes(
  evenement: StatistiquesEvenement,
  contexte: { consentementAttendu: boolean }
): Constat[] {
  const constats: Constat[] = [];
  const { nom, total } = evenement;

  /* La valeur monétaire. */
  if (evenement.avecValeur === 0 && evenement.valeurNonNumerique === 0) {
    constats.push({
      code: "valeur_absente",
      gravite: "critique",
      certitude: "mesure",
      titre: `« ${nom} » : ${total} occurrences, aucune ne porte de montant.`,
      detail:
        "Une conversion sans valeur peut être comptée mais jamais valorisée : le retour sur dépense publicitaire " +
        "est impossible à calculer, et les enchères intelligentes optimisent alors le NOMBRE de commandes, " +
        "pas le chiffre d'affaires.",
      action: "Ajouter une propriété de montant à l'événement (`value`, ou `total_eur` avec la devise dans le nom).",
      preuve: { nom, total, avecValeur: 0 },
    });
  } else if (evenement.avecValeur > 0 && evenement.avecValeur / total < COUVERTURE_ATTENDUE_VALEUR) {
    constats.push({
      code: "valeur_partielle",
      gravite: "avertissement",
      certitude: "mesure",
      titre: `« ${nom} » : ${evenement.avecValeur} montants lus sur ${total} occurrences (${pourcent(evenement.avecValeur, total)} %).`,
      detail:
        "Une partie des conversions partira sans valeur. Le chiffre d'affaires attribué à la publicité sera " +
        "sous-estimé, d'autant plus que les commandes sans montant sont souvent les mêmes (un tunnel, un pays).",
      action: "Chercher ce que les occurrences sans montant ont en commun (chemin, appareil, devise).",
      preuve: { nom, total, avecValeur: evenement.avecValeur, couverture: evenement.avecValeur / total },
    });
  }

  if (evenement.valeurNonNumerique > 0) {
    constats.push({
      code: "valeur_non_numerique",
      gravite: "avertissement",
      certitude: "mesure",
      titre: `« ${nom} » : ${evenement.valeurNonNumerique} occurrences portent un montant illisible.`,
      detail:
        "La propriété de montant existe mais son contenu n'est pas un nombre (chaîne formatée, montant avec " +
        "symbole ou séparateur de milliers). Ces occurrences sont traitées comme sans valeur, en silence.",
      action: "Envoyer un nombre brut, jamais une chaîne formatée : `49.9` et non `\"49,90 €\"`.",
      preuve: { nom, valeurNonNumerique: evenement.valeurNonNumerique, total },
    });
  }

  if (
    evenement.valeurMediane !== null &&
    (evenement.valeurMediane < MEDIANE_PLAUSIBLE_MIN || evenement.valeurMediane > MEDIANE_PLAUSIBLE_MAX)
  ) {
    const centimes = evenement.valeurMediane > MEDIANE_PLAUSIBLE_MAX;
    constats.push({
      code: "valeur_ordre_de_grandeur",
      gravite: "avertissement",
      certitude: "mesure",
      titre: `« ${nom} » : montant médian de ${evenement.valeurMediane}, hors de l'ordre de grandeur attendu.`,
      detail: centimes
        ? "Un montant médian aussi élevé est le symptôme classique de centimes envoyés comme des unités : " +
          "la valeur de conversion serait alors fausse d'un facteur cent, et le retour sur dépense avec elle."
        : "Un montant médian aussi faible suggère l'inverse : des unités envoyées comme des fractions, " +
          "ou une valeur par défaut à zéro qui écrase le vrai montant.",
      action: "Vérifier l'unité envoyée : la valeur de conversion s'exprime en unité monétaire principale, pas en centimes.",
      preuve: { nom, mediane: evenement.valeurMediane, min: evenement.valeurMin, max: evenement.valeurMax },
    });
  }

  /* L'identifiant de déduplication. */
  if (evenement.avecIdentifiant === 0) {
    constats.push({
      code: "identifiant_absent",
      gravite: "critique",
      certitude: "mesure",
      titre: `« ${nom} » : ${total} occurrences, aucune ne porte d'identifiant de commande.`,
      detail:
        "Sans identifiant stable, deux occurrences du même achat (rechargement de la page de confirmation, " +
        "retour arrière du navigateur) sont indistinguables. La conversion sera comptée deux fois chez la régie, " +
        "sans la moindre erreur nulle part, et le retour sur dépense sera surévalué.",
      action:
        "Ajouter une propriété d'identifiant à l'événement : `checkout_session_id` de préférence, à défaut " +
        "`order_id` ou `transaction_id`. La session de paiement est préférable, elle existe même quand la " +
        "commande ne s'est pas matérialisée.",
      preuve: { nom, total, avecIdentifiant: 0 },
    });
  } else if (evenement.avecIdentifiant / total < COUVERTURE_ATTENDUE_IDENTIFIANT) {
    constats.push({
      code: "identifiant_partiel",
      gravite: "avertissement",
      certitude: "mesure",
      titre: `« ${nom} » : ${evenement.avecIdentifiant} identifiants sur ${total} occurrences (${pourcent(evenement.avecIdentifiant, total)} %).`,
      detail:
        "Les occurrences sans identifiant ne peuvent pas être dédupliquées et risquent d'être comptées deux fois. " +
        "Un identifiant conditionnellement présent est le pire des deux mondes : il rassure sans protéger.",
      action: "Rendre l'identifiant inconditionnel, y compris sur le chemin qui en manque aujourd'hui.",
      preuve: { nom, total, avecIdentifiant: evenement.avecIdentifiant },
    });
  }

  /* Le consentement publicitaire — seulement s'il y a une régie derrière. */
  if (contexte.consentementAttendu) {
    if (evenement.avecConsentement === 0) {
      constats.push({
        code: "consentement_absent",
        gravite: "critique",
        certitude: "mesure",
        titre: `« ${nom} » : ${total} occurrences, le consentement publicitaire ne voyage sur aucune.`,
        detail:
          "Le signal `ads_consent_ad_user_data` n'est présent dans aucune occurrence. Sans lui, la plateforme " +
          "n'a aucun moyen de savoir si l'envoi vers la régie est autorisé — et le module d'envoi écarte par " +
          "défaut ce qu'il ne peut pas justifier. Résultat : rien ne part, et rien ne le signale.",
        action:
          "Faire porter à l'événement l'état du consentement publicitaire recueilli par le bandeau, " +
          "sous la clé `ads_consent_ad_user_data`.",
        preuve: { nom, total, avecConsentement: 0 },
      });
    } else if (evenement.avecConsentement / total < COUVERTURE_ATTENDUE_CONSENTEMENT) {
      constats.push({
        code: "consentement_partiel",
        gravite: "avertissement",
        certitude: "mesure",
        titre: `« ${nom} » : le consentement publicitaire ne voyage que sur ${evenement.avecConsentement} occurrences sur ${total}.`,
        detail:
          "Le signal manque sur une partie des occurrences. Attention : ce compteur mesure la PRÉSENCE du " +
          "signal, pas son contenu — un consentement refusé est présent et vaut « non ». Une absence est donc " +
          "un défaut de mesure, pas un refus de visiteur.",
        action: "Vérifier que le bandeau est lu avant l'émission de l'événement, y compris au premier chargement.",
        preuve: { nom, total, avecConsentement: evenement.avecConsentement },
      });
    }
  }

  /* La taille des propriétés — le seul constat qui ne peut PAS être affirmatif. */
  if (evenement.propsPresqueLongues > 0) {
    constats.push({
      code: "props_proches_limite",
      gravite: "avertissement",
      certitude: "indetermine",
      titre:
        `« ${nom} » : ${evenement.propsPresqueLongues} occurrences dont les propriétés frôlent la limite ` +
        `d'ingestion (jusqu'à ${evenement.propsTailleMax} octets sur 2048).`,
      detail:
        "Ce compteur ne dit pas combien d'occurrences ont été REJETÉES : celles qui dépassent 2048 octets sont " +
        "écartées avant l'écriture et n'existent nulle part. On ne peut donc que constater qu'on s'en approche, " +
        "et supposer que d'autres sont tombées.",
      action:
        "Alléger les propriétés de cet événement (ne pas y recopier le panier entier ; un identifiant suffit à " +
        "retrouver le détail).",
      preuve: { nom, propsPresqueLongues: evenement.propsPresqueLongues, tailleMax: evenement.propsTailleMax },
    });
  }

  return constats;
}

/* ────────────────────── Règles : cohérence Google Ads ───────────────────── */

function diagnostiquerCorrespondances(
  entrees: EntreesDiagnostic,
  nomsEmis: string[],
  parNom: Map<string, StatistiquesEvenement>
): Constat[] {
  const constats: Constat[] = [];

  // Pas de compte Ads : ce n'est pas un défaut, c'est le cas de la plupart des
  // sites. Une information, pour que l'écran ne laisse pas croire qu'on a vérifié
  // quelque chose qui n'existe pas.
  if (entrees.adsActif === null && entrees.correspondances.length === 0) {
    constats.push({
      code: "ads_non_configure",
      gravite: "information",
      certitude: "mesure",
      titre: "Aucun compte publicitaire n'est raccordé à ce site.",
      detail: "Les règles de cohérence publicitaire ne s'appliquent pas. Le reste du diagnostic reste valable.",
      action: "Rien à faire, sauf si des campagnes tournent : le raccordement se fait dans les réglages du site.",
      preuve: { correspondances: 0 },
    });
    return constats;
  }

  for (const correspondance of entrees.correspondances) {
    const stats = parNom.get(correspondance.eventName);
    if (stats && stats.total > 0) continue;

    const suggestion = suggerer(correspondance.eventName, nomsEmis);
    constats.push({
      code: "correspondance_sans_evenement",
      gravite: "critique",
      certitude: "mesure",
      titre:
        `La correspondance publicitaire vise « ${correspondance.eventName} », jamais émis sur ` +
        `${entrees.periode.jours} jours` +
        (suggestion ? ` — le site émet « ${suggestion} ».` : "."),
      detail:
        "Aucune conversion ne partira jamais par cette correspondance, et rien ne le signalera : le module " +
        "d'envoi ne demande que les noms configurés, donc il ne lit rien, donc tous ses compteurs valent zéro. " +
        "L'écran est alors indistinguable de celui d'un site sans trafic.",
      action: suggestion
        ? `Corriger la correspondance pour viser « ${suggestion} », ou faire émettre « ${correspondance.eventName} » par le site.`
        : "Corriger le nom de la correspondance, ou faire émettre cet événement par le site.",
      preuve: {
        eventName: correspondance.eventName,
        conversionActionId: correspondance.conversionActionId,
        suggestion,
        nomsEmis: nomsEmis.slice(0, 20),
      },
    });
  }

  // L'inverse : un achat mesuré qu'aucune correspondance ne couvre est une
  // conversion qu'on n'envoie pas. Silencieux, et coûteux : la régie optimise
  // alors sur autre chose que les ventes.
  const mappes = new Set(entrees.correspondances.map(c => c.eventName));
  for (const evenement of entrees.evenements) {
    if (!NOMS_ACHAT.has(evenement.nom)) continue;
    if (mappes.has(evenement.nom)) continue;
    if (evenement.total === 0) continue;
    constats.push({
      code: "conversion_non_declaree",
      gravite: "avertissement",
      certitude: "mesure",
      titre: `« ${evenement.nom} » : ${evenement.total} occurrences mesurées, aucune correspondance publicitaire ne les couvre.`,
      detail:
        "Ces conversions sont visibles dans l'analytics et ne remontent pas à la régie. Les enchères " +
        "automatiques optimisent donc sans connaître les ventes réelles.",
      action: `Créer une correspondance entre « ${evenement.nom} » et l'action de conversion correspondante.`,
      preuve: { nom: evenement.nom, total: evenement.total },
    });
  }

  return constats;
}

/* ───────────────────────── Règles : signaux d'alerte ────────────────────── */

function diagnostiquerSignaux(entrees: EntreesDiagnostic): Constat[] {
  const constats: Constat[] = [];
  const totalLignes = entrees.totalLignes;

  if (totalLignes > 0 && entrees.traficDatacenter / totalLignes > PART_DATACENTER_ALERTE) {
    constats.push({
      code: "trafic_datacenter",
      gravite: "avertissement",
      certitude: "mesure",
      titre:
        `${pourcent(entrees.traficDatacenter, totalLignes)} % du trafic mesuré vient de centres de données ` +
        `(${entrees.traficDatacenter} lignes sur ${totalLignes}).`,
      detail:
        "Ce trafic est presque toujours automatisé (surveillance, aspirateurs, prévisualisations). Il gonfle " +
        "les dénominateurs : tous les taux de conversion calculés sur cette période sont sous-estimés.",
      action: "Activer le filtrage du trafic de centre de données pour ce site, puis recalculer les taux.",
      preuve: { datacenter: entrees.traficDatacenter, total: totalLignes },
    });
  }

  if (entrees.nomsDistincts >= LIMITE_NOMS_EVENEMENTS) {
    constats.push({
      code: "noms_en_explosion",
      gravite: "critique",
      certitude: "mesure",
      titre: `${entrees.nomsDistincts} noms d'événements distincts : la limite de ${LIMITE_NOMS_EVENEMENTS} est atteinte.`,
      detail:
        "Au-delà, les nouveaux noms sont écartés. Le symptôme habituel est un nom d'événement fabriqué avec une " +
        "valeur variable dedans (un identifiant de produit, une page) au lieu d'être passé en propriété.",
      action: "Chercher le nom d'événement construit dynamiquement et déplacer sa partie variable dans les propriétés.",
      preuve: { nomsDistincts: entrees.nomsDistincts, limite: LIMITE_NOMS_EVENEMENTS },
    });
  } else if (entrees.nomsDistincts >= SEUIL_NOMS_EVENEMENTS) {
    constats.push({
      code: "noms_en_explosion",
      gravite: "avertissement",
      certitude: "mesure",
      titre: `${entrees.nomsDistincts} noms d'événements distincts, sur une limite de ${LIMITE_NOMS_EVENEMENTS}.`,
      detail: "À ce rythme la limite sera atteinte, et les noms suivants seront écartés sans erreur visible.",
      action: "Vérifier qu'aucun nom d'événement n'est construit avec une valeur variable.",
      preuve: { nomsDistincts: entrees.nomsDistincts, seuil: SEUIL_NOMS_EVENEMENTS },
    });
  }

  // Le trafic robot est la seule entrée qui peut manquer. On le DIT, plutôt que
  // de rendre un zéro qui se lirait « aucun robot ».
  if (entrees.traficRobot === null) {
    constats.push({
      code: "trafic_robot_inconnu",
      gravite: "information",
      certitude: "indetermine",
      titre: "Le volume de trafic robot n'a pas pu être lu pour cette période.",
      detail:
        "Ce n'est pas « aucun robot » : c'est « je n'ai pas la donnée ». Les autres constats restent valables, " +
        "mais la part de trafic automatisé n'est pas connue.",
      action: "Vérifier que la détection de robots est active pour ce site.",
      preuve: {},
    });
  }

  return constats;
}
