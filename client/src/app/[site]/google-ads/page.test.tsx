import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdsHealth, AdsMapping } from "@/api/google-ads";
import { renderAvecQuery } from "@/test/rendu-query";
import { useStore } from "@/lib/store";
import GoogleAdsPage from "./page";

// `useExtracted` vient du contexte next-intl, absent en test. Le remplacement
// interpole réellement les `{clés}` : un mock qui rendrait le gabarit brut
// laisserait passer un `{retard}` jamais substitué à l'écran.
vi.mock("next-intl", () => ({
  useExtracted: () => (message: string, values?: Record<string, string | number>) =>
    values ? message.replace(/\{(\w+)\}/g, (_, cle) => String(values[cle] ?? `{${cle}}`)) : message,
}));

// Le `SubHeader` de l'app tire tout le tableau de bord derrière lui (sélecteur
// de période, menu mobile, compteur temps réel, export). Le monter ici ne
// testerait pas cet écran-ci et ferait rougir cette page à la première
// modification d'un composant voisin. Ce qu'il porte pour Google Ads —
// `hideAnalyticsControls` — est vérifié par l'assertion sur les props reçues.
// Le `SubHeader` réel est IRRÉDUCTIBLE en test unitaire, et c'est mesuré, pas
// supposé : il tire le tableau de bord entier (menu mobile, sélecteur de
// période, compteur temps réel, export). Monté tel quel il exige, dans l'ordre,
// un `usePathname` non nul, puis l'adaptateur `nuqs` que seule la racine de
// l'app fournit (« nuqs requires an adapter to work with your framework »), et
// il déclenche à l'import un vrai `fetch` vers `localhost:3000` (session
// better-auth) qui remonte en erreur non gérée. Reproduire la racine de l'app
// pour ça ferait rougir cet écran à chaque modification d'un composant voisin.
// Ce que la page lui demande — `hideAnalyticsControls` — reste vérifié, sur les
// props reçues.
const propsSubHeader = vi.fn();
vi.mock("../components/SubHeader/SubHeader", () => ({
  SubHeader: (props: Record<string, unknown>) => {
    propsSubHeader(props);
    return <div data-testid="sous-entete" />;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/1/google-ads",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ site: "1" }),
}));

const useGetAdsHealth = vi.fn();
const useGetAdsMappings = vi.fn();

vi.mock("@/api/google-ads", () => ({
  useGetAdsHealth: (...args: unknown[]) => useGetAdsHealth(...args),
  useGetAdsMappings: (...args: unknown[]) => useGetAdsMappings(...args),
  useGetAdsSettings: () => ({ data: undefined, isLoading: false, error: null }),
  // Ajouté avec la carte des dépenses. Un mock incomplet ne rend pas une
  // valeur vide : vitest LÈVE sur l'export manquant, et les dix-sept tests de
  // ce fichier tombent d'un coup en accusant la page.
  useGetAdsCouts: () => ({ data: undefined, isLoading: false, error: null }),
}));

/** Un site branché, sain. Chaque test ne surcharge que ce qu'il éprouve. */
function sante(surcharge: Partial<AdsHealth> = {}): AdsHealth {
  return {
    configured: true,
    enabled: true,
    testMode: false,
    customerId: "123-456-7890",
    mappings: 2,
    pending: 3,
    sent: 42,
    failed: 1,
    skipped: 5,
    zeroValueSent: 0,
    lastError: null,
    lastSentAt: new Date().toISOString(),
    oldestPendingAt: new Date().toISOString(),
    oldestOverdueBy: null,
    ...surcharge,
  };
}

function correspondance(surcharge: Partial<AdsMapping> = {}): AdsMapping {
  return {
    id: 1,
    eventName: "purchase",
    conversionActionId: "987654321",
    defaultValue: "49.90",
    currency: "EUR",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...surcharge,
  };
}

/** L'allure d'un `useQuery` : seuls les champs que la page lit sont posés. */
function requete<T>(surcharge: Partial<{ data: T; isLoading: boolean; error: unknown }> = {}) {
  return {
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    ...surcharge,
  };
}

beforeEach(() => {
  // Le site vient du store posé par le layout, jamais d'une prop : sans lui la
  // page reste sur son squelette de chargement, et tous les tests
  // « configuré » passeraient au vert sans rien monter.
  useStore.setState({ site: "1" });
  useGetAdsHealth.mockReturnValue(requete<AdsHealth>({ data: sante() }));
  useGetAdsMappings.mockReturnValue(requete({ data: { mappings: [correspondance()] } }));
});

afterEach(() => {
  // `cleanup()` et non `document.body.innerHTML = ""` : vider le corps à la
  // main arrache les portails Radix sous les pieds de React, qui échoue ensuite
  // à démonter un composant d'un test SANS RAPPORT. Cette page en ouvre (les
  // infobulles du tableau des correspondances).
  cleanup();
  vi.clearAllMocks();
});

describe("Page Google Ads — les états qui comptent", () => {
  it("rend le squelette tant que l'état de santé n'est pas arrivé", () => {
    useGetAdsHealth.mockReturnValue(requete<AdsHealth>({ isLoading: true }));

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText("Google Ads")).toBeTruthy();
    // Rien de l'écran de santé ne doit être affiché à ce stade : montrer des
    // compteurs vides pendant le chargement se lit comme « rien n'est arrivé ».
    expect(screen.queryByText(/counters cover the whole queue/i)).toBeNull();
  });

  it("rend le squelette tant que le site du store est inconnu", () => {
    useStore.setState({ site: "" });

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.queryByText(/counters cover the whole queue/i)).toBeNull();
  });

  it("propose de brancher le compte sur un site jamais configuré", () => {
    useGetAdsHealth.mockReturnValue(
      requete<AdsHealth>({ data: sante({ configured: false, customerId: null, mappings: 0, sent: 0, pending: 0 }) })
    );

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/not connected to this site yet/i)).toBeTruthy();
    // Le tableau des correspondances n'a aucun sens tant que rien n'est
    // branché : une table vide s'y lirait comme « rien à envoyer ».
    expect(screen.queryByText("Mapped conversions")).toBeNull();
  });

  it("affiche les compteurs et les correspondances sur un site sain", () => {
    useGetAdsHealth.mockReturnValue(requete<AdsHealth>({ data: sante({ failed: 0 }) }));

    renderAvecQuery(<GoogleAdsPage />);

    // La pastille dit « Sending » et non « Failures » : le jeu de base porte un
    // échec, celui-ci n'en porte aucun.
    expect(screen.getByText("Sending")).toBeTruthy();
    expect(screen.getByText("Mapped conversions")).toBeTruthy();
    expect(screen.getByText("purchase")).toBeTruthy();
  });

  it("distingue « branché mais rien reçu » d'un site non configuré", () => {
    useGetAdsHealth.mockReturnValue(
      requete<AdsHealth>({
        data: sante({ pending: 0, sent: 0, failed: 0, skipped: 0, lastSentAt: null, oldestPendingAt: null }),
      })
    );

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/No conversion recorded yet/i)).toBeTruthy();
    expect(screen.queryByText(/not connected to this site yet/i)).toBeNull();
  });

  it("annonce le mode d'essai en bandeau", () => {
    useGetAdsHealth.mockReturnValue(requete<AdsHealth>({ data: sante({ testMode: true }) }));

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/Test mode is on/i)).toBeTruthy();
  });

  it("alerte quand le drain est arrêté", () => {
    useGetAdsHealth.mockReturnValue(
      requete<AdsHealth>({ data: sante({ pending: 12, oldestOverdueBy: 3 * 3600 }) })
    );

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/piling up and are not being sent/i)).toBeTruthy();
    // Le retard doit être INTERPOLÉ, pas laissé en gabarit.
    expect(screen.getByText(/due 3 h ago/i)).toBeTruthy();
  });

  it("montre une erreur récupérable quand l'état de santé ne se charge pas", () => {
    useGetAdsHealth.mockReturnValue(requete<AdsHealth>({ error: new Error("boom réseau") }));

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/Could not read the Google Ads status/i)).toBeTruthy();
    expect(screen.getByText(/boom réseau/i)).toBeTruthy();
  });

  it("ne reste pas sur une page blanche si le serveur répond sans état", () => {
    useGetAdsHealth.mockReturnValue(requete<AdsHealth>({ data: undefined }));

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/answered without a status/i)).toBeTruthy();
  });

  it("invite à créer une correspondance quand la liste est vide", () => {
    useGetAdsMappings.mockReturnValue(requete({ data: { mappings: [] } }));

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/No event is mapped yet/i)).toBeTruthy();
  });

  it("rend un squelette de table tant que les correspondances chargent", () => {
    useGetAdsMappings.mockReturnValue(requete({ isLoading: true }));

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText("Mapped conversions")).toBeTruthy();
    expect(screen.queryByText(/No event is mapped yet/i)).toBeNull();
  });

  it("retire les contrôles d'analyse du sous-entête", () => {
    renderAvecQuery(<GoogleAdsPage />);

    // Les compteurs portent sur TOUTE la file : un sélecteur de période qui ne
    // pilote rien ferait lire une baisse là où il n'y a qu'un changement de
    // dates.
    expect(propsSubHeader).toHaveBeenCalledWith(expect.objectContaining({ hideAnalyticsControls: true }));
  });
});

describe("Page Google Ads — les valeurs limites qui font tomber un rendu", () => {
  it("rend avec tous les champs facultatifs à null", () => {
    useGetAdsHealth.mockReturnValue(
      requete<AdsHealth>({
        data: sante({
          customerId: null,
          lastError: null,
          lastSentAt: null,
          oldestPendingAt: null,
          oldestOverdueBy: null,
        }),
      })
    );
    useGetAdsMappings.mockReturnValue(requete({ data: { mappings: [] } }));

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/counters cover the whole queue/i)).toBeTruthy();
  });

  it("rend une dernière erreur dont l'horodatage n'est pas une date", () => {
    useGetAdsHealth.mockReturnValue(
      requete<AdsHealth>({
        data: sante({ lastError: { message: "INVALID_CUSTOMER_ID", at: "pas-une-date" } }),
      })
    );

    renderAvecQuery(<GoogleAdsPage />);

    // Luxon rend `null` sur une date invalide : l'écran doit retomber sur la
    // chaîne brute plutôt que d'afficher un trou.
    expect(screen.getByText(/pas-une-date/i)).toBeTruthy();
    expect(screen.getByText("INVALID_CUSTOMER_ID")).toBeTruthy();
  });

  it("rend une dernière erreur au message vide", () => {
    useGetAdsHealth.mockReturnValue(
      requete<AdsHealth>({ data: sante({ lastError: { message: "", at: new Date().toISOString() } }) })
    );

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/Last error/i)).toBeTruthy();
  });

  it("rend un retard nul sans le confondre avec une absence de retard", () => {
    useGetAdsHealth.mockReturnValue(requete<AdsHealth>({ data: sante({ oldestOverdueBy: 0 }) }));

    renderAvecQuery(<GoogleAdsPage />);

    // 0 seconde de retard reste sous le seuil : aucune alerte, mais surtout
    // aucune exception sur un `null` supposé.
    expect(screen.queryByText(/piling up and are not being sent/i)).toBeNull();
  });

  it("rend une correspondance sans montant ni devise lisible", () => {
    useGetAdsMappings.mockReturnValue(
      requete({
        data: {
          mappings: [
            correspondance({ id: 1, defaultValue: null, currency: "" }),
            correspondance({ id: 2, eventName: "", conversionActionId: "", defaultValue: "0", createdAt: "" }),
          ],
        },
      })
    );

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText("Mapped conversions")).toBeTruthy();
  });

  it("rend des compteurs à des valeurs extrêmes", () => {
    useGetAdsHealth.mockReturnValue(
      requete<AdsHealth>({
        data: sante({ pending: 1_234_567, sent: 0, failed: 0, skipped: 0, zeroValueSent: 987, mappings: 0 }),
      })
    );

    renderAvecQuery(<GoogleAdsPage />);

    expect(screen.getByText(/No event is mapped to a conversion action/i)).toBeTruthy();
  });
});
