/**
 * Le contrôle qui refuse la RÉAPPARITION d'un verrou commercial de l'amont.
 *
 * POURQUOI. Rybbit se vend en offre cloud payante. Son modèle économique vit dans
 * le code sous la forme du drapeau `IS_CLOUD` (`lib/const.ts`), qui vaut FAUX chez
 * nous. Chaque fonctionnalité enveloppée dans `{IS_CLOUD && ...}` disparaît donc de
 * NOTRE instance, sans que rien ne le signale : l'écran n'est pas cassé, il n'existe
 * pas. Trois entrées de menu (Pages, Performance, Bots) et le bouton Web Vitals
 * étaient dans ce cas, alors que les pages rendaient de vraies données.
 *
 * À chaque reprise de commits de l'amont, ces conditions reviennent. Ce test dit
 * lesquelles on connaît, et NOMME les nouvelles.
 *
 * UN ENSEMBLE, JAMAIS UN COMPTEUR. Un compteur descend quand un fichier disparaît
 * et remonte quand il revient, ce qui fabrique de fausses régressions dans les deux
 * sens. On compare donc des ensembles : une condition qui disparaît est tolérée
 * (refactorisation), une condition NOUVELLE est signalée avec son fichier et son
 * texte. Les répétitions d'une même ligne dans un même fichier ne comptent pas.
 *
 * TROIS ÉTATS. Conforme · régression nommée · MESURE NON ABOUTIE. Le troisième est
 * le plus important : si le balayage ne trouve plus de fichiers (chemin déplacé,
 * arborescence renommée), une sortie vide dirait « aucun verrou » et vaudrait
 * bulletin de santé parfait. Le test échoue alors en disant que la MESURE n'a pas
 * abouti, pas qu'il n'y a rien à signaler.
 *
 * LE PIÈGE À ÉVITER, et il a coûté deux faux positifs le 31/08/2026 : un contrôle
 * qui lit du texte compte aussi les `IS_CLOUD` cités dans les COMMENTAIRES — or ce
 * fichier-ci, et les commentaires qui expliquent chaque verrou levé, en citent
 * beaucoup. D'où `retirerCommentaires`, et son autotest ci-dessous : le mécanisme
 * de mesure se vérifie sur un cas dont on connaît la réponse AVANT de conclure quoi
 * que ce soit sur le dépôt.
 *
 * QUAND IL ROUGIT. Lire la ligne signalée. Si c'est un verrou commercial sur une
 * fonctionnalité qui marche chez nous, on retire la CONDITION (jamais on ne bascule
 * `NEXT_PUBLIC_CLOUD` : le drapeau porte aussi des conditions inverses, l'activer
 * ferait disparaître Requête et Tableaux de bord et allumerait la facturation
 * Stripe). Si c'est légitime (Stripe, AppSumo, Turnstile, parrainage), on ajoute la
 * ligne à `VERROUS_CONNUS` avec sa raison dans le message de commit.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RACINE_SRC = path.resolve(__dirname, "..");

/**
 * Retire commentaires de bloc et de ligne, en laissant les chaînes intactes.
 * Sans ça, la prose qui EXPLIQUE un verrou levé serait comptée comme le verrou
 * lui-même.
 */
function retirerCommentaires(source: string): string {
  let sortie = "";
  let i = 0;
  let etat: "code" | "chaine" | "bloc" | "ligne" = "code";
  let delimiteur = "";

  while (i < source.length) {
    const c = source[i];
    const suivant = source[i + 1];

    if (etat === "code") {
      if (c === "/" && suivant === "*") {
        etat = "bloc";
        i += 2;
        continue;
      }
      if (c === "/" && suivant === "/") {
        etat = "ligne";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        etat = "chaine";
        delimiteur = c;
      }
      sortie += c;
      i++;
      continue;
    }

    if (etat === "chaine") {
      if (c === "\\") {
        sortie += c + (suivant ?? "");
        i += 2;
        continue;
      }
      if (c === delimiteur) etat = "code";
      sortie += c;
      i++;
      continue;
    }

    if (etat === "bloc") {
      if (c === "*" && suivant === "/") {
        etat = "code";
        i += 2;
        continue;
      }
      if (c === "\n") sortie += "\n";
      i++;
      continue;
    }

    // etat === "ligne"
    if (c === "\n") {
      etat = "code";
      sortie += "\n";
    }
    i++;
  }

  return sortie;
}

function fichiersSource(dossier: string, accumulateur: string[] = []): string[] {
  for (const entree of readdirSync(dossier)) {
    const chemin = path.join(dossier, entree);
    if (statSync(chemin).isDirectory()) {
      fichiersSource(chemin, accumulateur);
    } else if (/\.tsx?$/.test(entree) && !/\.test\.tsx?$/.test(entree)) {
      accumulateur.push(chemin);
    }
  }
  return accumulateur;
}

/** Relève les conditions `IS_CLOUD` présentes dans le CODE, hors imports. */
function releverVerrous(): { conditions: Set<string>; fichiersLus: number } {
  const conditions = new Set<string>();
  const fichiers = fichiersSource(RACINE_SRC);

  for (const fichier of fichiers) {
    const relatif = path.relative(RACINE_SRC, fichier);
    const code = retirerCommentaires(readFileSync(fichier, "utf8"));
    for (const ligne of code.split("\n")) {
      if (!/\bIS_CLOUD\b/.test(ligne)) continue;
      if (/^\s*import\b/.test(ligne)) continue; // un import seul n'est pas un verrou
      conditions.add(`${relatif} :: ${ligne.trim().replace(/\s+/g, " ")}`);
    }
  }

  return { conditions, fichiersLus: fichiers.length };
}

/**
 * Les conditions `IS_CLOUD` connues au 01/09/2026, chacune examinée et jugée
 * légitime pour notre instance : facturation Stripe, AppSumo, Turnstile,
 * parrainage, lien de support de l'amont, mode démo, ou condition INVERSE
 * (`!IS_CLOUD`) qui nous OUVRE une fonctionnalité au lieu de nous la fermer.
 *
 * Le détail de ce qui a été rallumé et de ce qui reste éteint, avec sa raison
 * mesurée, vit dans les commentaires posés au-dessus de chaque geste.
 */
const VERROUS_CONNUS: readonly string[] = [
  "api/admin/hooks/useImport.ts :: const isFreeTier = IS_CLOUD && subscription?.eventLimit === DEFAULT_EVENT_LIMIT;",
  "app/[site]/components/Header/AffiliateBanner.tsx :: if (!IS_CLOUD || !isProduction || dismissed) return null;",
  'app/[site]/components/shared/StandardSection/StandardSection.tsx :: {IS_CLOUD && ["Countries", "Regions", "Cities"].includes(title) && (',
  "app/[site]/components/Sidebar/Sidebar.tsx :: {!IS_CLOUD && (",
  'app/[site]/globe/globeStore.ts :: mapMode: IS_CLOUD ? "3D" : "2D",',
  "app/[site]/replay/components/EnableSessionReplay.tsx :: const canEnableReplay = !IS_CLOUD || planIncludesReplay(subscription);",
  "app/as/callback/page.tsx :: {IS_CLOUD && (",
  "app/as/callback/page.tsx :: disabled={IS_CLOUD ? !turnstileToken || isLoading : isLoading}",
  "app/as/callback/page.tsx :: if (IS_CLOUD && !turnstileToken) {",
  "app/as/callback/page.tsx :: if (IS_CLOUD && turnstileToken) {",
  "app/components/AddSite.tsx :: badge={IS_CLOUD ? toggle.badge : undefined}",
  "app/components/AddSite.tsx :: const isOverSiteLimit = IS_CLOUD && siteLimit !== null && (sites?.sites?.length || 0) >= siteLimit;",
  "app/components/AddSite.tsx :: const sessionReplayDisabled = !planIncludesReplay(subscription) && IS_CLOUD;",
  'app/components/AddSite.tsx :: if (subscription?.status !== "active" && subscription?.status !== "trialing" && IS_CLOUD) {',
  "app/components/AddSite.tsx :: IS_CLOUD;",
  "app/invitation/components/signup.tsx :: {IS_CLOUD && (",
  "app/invitation/components/signup.tsx :: disabled={IS_CLOUD ? !turnstileToken || isLoading : isLoading}",
  "app/invitation/components/signup.tsx :: if (IS_CLOUD && !turnstileToken) {",
  "app/invitation/components/signup.tsx :: if (IS_CLOUD && turnstileToken) {",
  "app/login/page.tsx :: {!IS_CLOUD && (",
  'app/login/page.tsx :: const turnstileEnabled = IS_CLOUD && process.env.NODE_ENV === "production";',
  'app/login/page.tsx :: if (IS_CLOUD && process.env.NODE_ENV === "production" && !turnstileToken) {',
  'app/login/page.tsx :: if (IS_CLOUD && process.env.NODE_ENV === "production" && turnstileToken) {',
  "app/login/page.tsx :: IS_CLOUD && (",
  'app/reset-password/page.tsx :: {IS_CLOUD && process.env.NODE_ENV === "production" && (',
  'app/reset-password/page.tsx :: disabled={IS_CLOUD && process.env.NODE_ENV === "production" ? !turnstileToken || isLoading : isLoading}',
  'app/reset-password/page.tsx :: if (IS_CLOUD && process.env.NODE_ENV === "production" && !turnstileToken) {',
  'app/reset-password/page.tsx :: if (IS_CLOUD && process.env.NODE_ENV === "production" && turnstileToken) {',
  "app/settings/account/components/AccountInner.tsx :: {(session.data?.user as any)?.sendAutoEmailReports !== undefined && IS_CLOUD && (",
  "app/settings/account/components/ApiKeyManager.tsx :: const isPlanGated = IS_CLOUD && isFreePlan;",
  "app/settings/organization/components/InviteMemberDialog.tsx :: if (!IS_CLOUD) return false;",
  "app/settings/organization/components/MembersTable.tsx :: {IS_CLOUD ? (",
  "app/signup/components/AccountStep.tsx :: {IS_CLOUD && (",
  "app/signup/components/AccountStep.tsx :: disabled={IS_CLOUD ? !turnstileToken || isLoading : isLoading}",
  "app/signup/components/SetupStep.tsx :: (IS_CLOUD && !referralSource)",
  'app/signup/components/SetupStep.tsx :: {IS_CLOUD ? t("Start free trial") : t("Continue")}',
  "app/signup/components/SetupStep.tsx :: {IS_CLOUD && (",
  "app/signup/page.tsx :: {!IS_CLOUD && (",
  'app/signup/page.tsx :: {IS_CLOUD ? t("Start your 7-day free trial") : t("Get started with Rybbit")}',
  "app/signup/page.tsx :: {IS_CLOUD && (",
  "app/signup/page.tsx :: const maxStep = IS_CLOUD ? 3 : 2;",
  "app/signup/page.tsx :: const steps = IS_CLOUD",
  "app/signup/page.tsx :: if (IS_CLOUD && !turnstileToken) {",
  "app/signup/page.tsx :: if (IS_CLOUD && referralSource && userStore.getState().user?.id) {",
  "app/signup/page.tsx :: if (IS_CLOUD && turnstileToken) {",
  "app/signup/page.tsx :: if (IS_CLOUD) {",
  'components/AppSidebar.tsx :: {IS_CLOUD && (subscription?.status === "active" || subscription?.status === "trialing") && (',
  "components/AppSidebar.tsx :: if ((!IS_CLOUD && !DEPLOYMENT) || !isAdmin) return null;",
  "components/DisabledOverlay.tsx :: if (!IS_CLOUD) {",
  "components/sidebar/NavigationSidebar.tsx :: {IS_CLOUD && (",
  "components/SiteSettings/ImportManager.tsx :: const hasActiveImport = IS_CLOUD && sortedImports.some(imp => imp.completedAt === null);",
  "components/SiteSettings/TrackingTab.tsx :: badge={IS_CLOUD ? toggle.badge : undefined}",
  "components/SiteSettings/TrackingTab.tsx :: const sessionReplayDisabled = !planIncludesReplay(subscription) && IS_CLOUD;",
  "components/SiteSettings/TrackingTab.tsx :: IS_CLOUD;",
  "components/subscription/components/InvoicesCard.tsx :: enabled: !!activeOrg && IS_CLOUD,",
  'components/VersionCheck.tsx :: if (IS_CLOUD || typeof window === "undefined") return false;',
  'lib/const.ts :: export const IS_CLOUD = process.env.NEXT_PUBLIC_CLOUD === "true";',
  "lib/subscription/useStripeSubscription.ts :: if (!activeOrg || !IS_CLOUD) {",
];

/** Ce que ce fork a rallumé, et qui doit rester allumé. */
const CHEMIN_MENU = path.join(RACINE_SRC, "app/[site]/components/Sidebar/Sidebar.tsx");
const ENTREES_RALLUMEES = [
  "pages", // 31/08/2026 : /19/pages rend les vraies données du WordPress d'ASD
  "performance", // 01/09/2026 : Web Vitals réels (LCP 5,3 s, CLS, INP, FCP, TTFB)
  "bots", // 01/09/2026 : 181 requêtes bloquées, 30 % du trafic
  "feature-flags", // 01/09/2026 : état vide + dialogue complet, 6 routes serveur
  "experiments", // 01/09/2026 : assistant 4 étapes, 5 routes serveur
] as const;

describe("le mécanisme de mesure lui-même", () => {
  // Une mesure qu'on n'a pas vue se tromper est une intention, pas une mesure.
  it("ne compte pas un IS_CLOUD cité dans un commentaire", () => {
    const source = [
      "// {IS_CLOUD && <Facture />}",
      "/* On a retiré la condition IS_CLOUD ici, cf. preuve du 01/09. */",
      "const vrai = IS_CLOUD;",
    ].join("\n");

    const restant = retirerCommentaires(source)
      .split("\n")
      .filter(ligne => /\bIS_CLOUD\b/.test(ligne));

    expect(restant).toEqual(["const vrai = IS_CLOUD;"]);
  });

  it("laisse intact un IS_CLOUD qui vit dans une chaîne", () => {
    const source = 'const message = "IS_CLOUD"; // et pas celui-ci : IS_CLOUD';
    expect(retirerCommentaires(source)).toBe('const message = "IS_CLOUD"; ');
  });
});

describe("verrous commerciaux de l'amont", () => {
  it("ne laisse apparaître aucune condition IS_CLOUD inconnue", () => {
    const { conditions, fichiersLus } = releverVerrous();

    // ⚠️ MESURE NON ABOUTIE — le troisième état. Une sortie vide ne prouve rien :
    // si l'arborescence a bougé, le balayage ne lit plus rien et « aucun verrou »
    // serait un bulletin de santé parfait délivré sans avoir regardé.
    expect(
      fichiersLus,
      `⚠️ MESURE NON ABOUTIE, ce n'est PAS « rien à signaler » : seulement ${fichiersLus} fichiers lus sous ${RACINE_SRC}. Le balayage ne trouve plus les sources — vérifier le chemin avant de conclure quoi que ce soit.`
    ).toBeGreaterThan(200);
    expect(
      conditions.size,
      `⚠️ MESURE NON ABOUTIE : ${fichiersLus} fichiers lus mais AUCUNE condition IS_CLOUD trouvée, alors que \`lib/const.ts\` en déclare une. Le releveur est cassé, pas le dépôt propre.`
    ).toBeGreaterThan(0);

    const connus = new Set(VERROUS_CONNUS);
    const nouveaux = [...conditions].filter(condition => !connus.has(condition)).sort();

    expect(
      nouveaux,
      `RÉGRESSION : ${nouveaux.length} condition(s) IS_CLOUD nouvelle(s), probablement reprises de l'amont. Chacune CACHE quelque chose sur notre instance sans rien signaler.\n\n${nouveaux
        .map(n => `  • ${n}`)
        .join(
          "\n"
        )}\n\nSi la fonctionnalité marche chez nous : retirer la CONDITION (jamais basculer NEXT_PUBLIC_CLOUD). Sinon : ajouter la ligne à VERROUS_CONNUS avec sa raison.`
    ).toEqual([]);
  });

  it("garde dans le menu les entrées que ce fork a rallumées", () => {
    const menu = retirerCommentaires(readFileSync(CHEMIN_MENU, "utf8"));

    // Le fichier doit avoir été lu : sinon les assertions suivantes passeraient
    // sur une chaîne vide, en beauté et sans rien prouver.
    expect(menu.length, `⚠️ MESURE NON ABOUTIE : ${CHEMIN_MENU} est vide ou illisible.`).toBeGreaterThan(1000);

    for (const entree of ENTREES_RALLUMEES) {
      expect(
        menu,
        `RÉGRESSION : l'entrée de menu « ${entree} » n'est plus dans le code actif de la barre latérale. Elle a été soit re-commentée, soit ré-enveloppée dans IS_CLOUD par une reprise de l'amont. La page fonctionne pourtant : c'est un verrou commercial, pas une limite technique.`
      ).toContain(`getTabPath("${entree}")`);
    }
  });

  it("garde le bouton Web Vitals accessible hors offre cloud", () => {
    // Sans ce bouton, la page Performance ne peut JAMAIS être alimentée depuis
    // l'interface : la donnée n'existe que si quelqu'un a pu cocher la case.
    //
    // On regarde une FENÊTRE, pas la ligne. Première version de ce test : elle
    // cherchait `IS_CLOUD` et `webVitals` sur la même ligne. Le contrôle négatif
    // du 01/09/2026 l'a prise en défaut — le verrou de l'amont s'écrit
    // `...(IS_CLOUD && !isMobileSite` TROIS LIGNES au-dessus de `id: "webVitals"`,
    // et le test restait vert sur un fichier saboté. Marges mesurées le même jour
    // sur les fichiers sains : 893 et 1006 caractères jusqu'au `IS_CLOUD` le plus
    // proche, contre 60 sur le fichier saboté. 400 sépare les deux sans ambiguïté.
    const FENETRE = 400;
    const ancres = [
      ["components/SiteSettings/TrackingTab.tsx", 'id: "webVitals"'],
      ["app/components/AddSite.tsx", 'key: "webVitals"'],
    ] as const;

    for (const [fichier, ancre] of ancres) {
      const code = retirerCommentaires(readFileSync(path.join(RACINE_SRC, fichier), "utf8"));
      const position = code.indexOf(ancre);

      // Sans l'ancre, le reste de ce test regarderait une fenêtre vide et
      // conclurait « conforme » sans avoir rien mesuré.
      expect(
        position,
        `⚠️ MESURE NON ABOUTIE : \`${ancre}\` est introuvable dans ${fichier}. Le bouton a peut-être été renommé — retrouver son ancre, ne pas supprimer ce contrôle.`
      ).toBeGreaterThan(-1);

      const voisinage = code.slice(Math.max(0, position - FENETRE), position + FENETRE);

      expect(
        voisinage,
        `RÉGRESSION dans ${fichier} : le bouton Web Vitals est de nouveau conditionné à IS_CLOUD, donc invisible chez nous — et la page Performance redevient inalimentable depuis l'interface.\n\n${voisinage}`
      ).not.toMatch(/\bIS_CLOUD\b/);
    }
  });
});
