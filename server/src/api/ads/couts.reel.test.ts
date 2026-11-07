/**
 * Preuve réseau réelle : notre lecteur parle-t-il correctement à l'API Ads ?
 *
 * Les tests de `couts.test.ts` valident l'analyse avec un `fetch` simulé. Ils ne
 * prouvent rien de ce que Google accepte réellement — et c'est là que se logent
 * les pièges : la version dans l'URL, les deux en-têtes propres à cette API, la
 * forme en TABLEAU DE LOTS de `searchStream`, et le nom exact des champs GAQL.
 *
 * 🔴 IGNORÉ PAR DÉFAUT. Ne s'exécute que si `ADS_PREUVE_REELLE=1`, parce qu'il
 * fait de VRAIS appels. Il ne doit jamais tourner en intégration continue.
 *
 * Il n'écrit RIEN et ne dépense RIEN : la lecture de rapports ne modifie aucun
 * compte et n'engage aucun budget.
 *
 * Lancement :
 *   set -a; source ~/credentials/.all-creds.env; set +a
 *   ADS_PREUVE_REELLE=1 npx vitest run src/api/ads/couts.reel.test.ts
 */
import { describe, expect, it } from "vitest";
import { AdsCoutsError, identifiantsDepuisEnv, lireCoutsCampagnes } from "./couts.js";

const ACTIF = process.env.ADS_PREUVE_REELLE === "1";

/** Societe A : le seul compte du MCC qui dépense vraiment (relevé N-N-N). */
const COMPTE_QUI_DEPENSE = "6336440750";
/** Compte ASD : existe, ne dépense pas. Sert de contrôle « zéro légitime ». */
const COMPTE_SANS_DEPENSE = "2568911678";

function fenetre(jours: number): [string, string] {
  const fin = new Date(Date.now() - 86_400_000);
  const debut = new Date(fin.getTime() - jours * 86_400_000);
  return [debut.toISOString().slice(0, 10), fin.toISOString().slice(0, 10)];
}

describe.skipIf(!ACTIF)("preuve réelle contre l'API Google Ads", () => {
  const ids = identifiantsDepuisEnv();

  it("les cinq identifiants sont présents", () => {
    expect(ids, "coffre non chargé : set -a; source ~/credentials/.all-creds.env").not.toBeNull();
  });

  it("lit de VRAIES dépenses sur le compte qui dépense", async () => {
    const [debut, fin] = fenetre(30);
    const lignes = await lireCoutsCampagnes(COMPTE_QUI_DEPENSE, debut, fin, ids!);
    expect(lignes.length, "aucune ligne : la requête ou la version d'API a changé").toBeGreaterThan(0);

    // Chaque ligne porte SA date : c'est ce qui prouve que `segments.date` est
    // bien sélectionné et non seulement filtré. Sans cela, Google agrégerait
    // tout sur une ligne et l'import écrirait un mois sur un seul jour.
    const dates = new Set(lignes.map(l => l.date));
    expect(dates.size, "une seule date sur 30 jours : segments.date n'est pas sélectionné").toBeGreaterThan(1);
    for (const l of lignes) expect(l.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const total = lignes.reduce((s, l) => s + l.costMicros, 0);
    expect(total, "coût total nul sur un compte qui dépense").toBeGreaterThan(0);
    expect(lignes.every(l => l.currency.length === 3)).toBe(true);
  });

  it("rend zéro ligne sur un compte sans dépense, SANS erreur", async () => {
    // Contrôle du sens inverse : « aucune dépense » doit se lire comme un
    // résultat normal, pas comme une panne. Sans ce cas, un compte inactif
    // ferait rougir l'import tous les jours et on finirait par le débrancher.
    const [debut, fin] = fenetre(7);
    const lignes = await lireCoutsCampagnes(COMPTE_SANS_DEPENSE, debut, fin, ids!);
    expect(Array.isArray(lignes)).toBe(true);
    expect(lignes.reduce((s, l) => s + l.costMicros, 0)).toBe(0);
  });

  it("classe un compte hors périmètre en échec NON réessayable", async () => {
    // Contrôle négatif : sans lui, le vert des deux tests ci-dessus ne
    // prouverait pas que l'API discrimine quoi que ce soit.
    const [debut, fin] = fenetre(7);
    await expect(lireCoutsCampagnes("1234567890", debut, fin, ids!)).rejects.toMatchObject({
      name: "AdsCoutsError",
      reessayable: false,
    });
  });

  it("une version d'API inexistante est nommée, pas confondue avec un compte vide", async () => {
    // Google rend du HTML sur une version périmée. Ce test fige le fait que
    // notre code le NOMME au lieu de rendre une liste vide.
    const [debut, fin] = fenetre(2);
    const fauxFetch: typeof fetch = async (url, init) => {
      const cible = String(url).replace("/v23/", "/v1/");
      return fetch(cible as string, init);
    };
    await expect(
      lireCoutsCampagnes(COMPTE_QUI_DEPENSE, debut, fin, ids!, fauxFetch)
    ).rejects.toThrow(AdsCoutsError);
  });
});
