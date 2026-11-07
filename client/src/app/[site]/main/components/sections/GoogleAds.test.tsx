import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdsHealth } from "@/api/google-ads";
import { renderAvecQuery } from "@/test/rendu-query";
import { GoogleAds } from "./GoogleAds";

vi.mock("next-intl", () => ({
  useExtracted: () => (message: string, values?: Record<string, string | number>) =>
    values ? message.replace(/\{(\w+)\}/g, (_, cle) => String(values[cle] ?? `{${cle}}`)) : message,
}));

// Le chemin décide du lien « Détails » (et de sa présence). Il est piloté test
// par test, car la carte doit aussi tenir quand le chemin ne porte aucun site.
const chemin = vi.fn<() => string | null>(() => "/1/main");
vi.mock("next/navigation", () => ({
  usePathname: () => chemin(),
}));

const useGetAdsHealth = vi.fn();
vi.mock("@/api/google-ads", () => ({
  useGetAdsHealth: (...args: unknown[]) => useGetAdsHealth(...args),
  useGetAdsMappings: () => ({ data: undefined, isLoading: false, error: null }),
  useGetAdsSettings: () => ({ data: undefined, isLoading: false, error: null }),
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

function requete(surcharge: Partial<{ data: AdsHealth; isLoading: boolean; error: unknown; refetch: () => void }> = {}) {
  return { data: undefined, isLoading: false, error: null, refetch: vi.fn(), ...surcharge };
}

beforeEach(() => {
  chemin.mockReturnValue("/1/main");
  useGetAdsHealth.mockReturnValue(requete({ data: sante() }));
});

afterEach(() => {
  // `cleanup()` et non `document.body.innerHTML = ""` : vider le corps à la
  // main arrache les portails Radix sous les pieds de React, qui échoue ensuite
  // à démonter un composant d'un test SANS RAPPORT.
  cleanup();
  vi.clearAllMocks();
});

describe("Carte Google Ads du tableau de bord — les états qui comptent", () => {
  it("rend un chargement sans compteur", () => {
    useGetAdsHealth.mockReturnValue(requete({ isLoading: true }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText("Google Ads")).toBeTruthy();
    expect(screen.queryByText("Pending")).toBeNull();
  });

  it("invite à brancher le compte sur un site jamais configuré", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ configured: false }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/is not connected yet/i)).toBeTruthy();
    // Aucun compteur : « pas encore branché » et « branché, rien envoyé »
    // demandent des gestes opposés, les confondre fait chercher une panne
    // inexistante.
    expect(screen.queryByText("Pending")).toBeNull();
  });

  it("affiche les quatre compteurs sur un site branché", () => {
    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Discarded")).toBeTruthy();
  });

  it("distingue « branché, rien reçu » de « non branché »", () => {
    useGetAdsHealth.mockReturnValue(
      requete({ data: sante({ pending: 0, sent: 0, failed: 0, skipped: 0, lastSentAt: null, oldestPendingAt: null }) })
    );

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/Set up and waiting/i)).toBeTruthy();
    expect(screen.queryByText(/is not connected yet/i)).toBeNull();
  });

  it("annonce le mode d'essai", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ testMode: true }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/Test mode is on/i)).toBeTruthy();
  });

  it("alerte quand le drain est arrêté, avec le retard interpolé", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ pending: 12, oldestOverdueBy: 45 * 60 }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/due 45 min ago and never ran/i)).toBeTruthy();
  });

  it("n'alerte pas sur un retard sous le seuil de tolérance", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ pending: 4, oldestOverdueBy: 60 }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.queryByText(/never ran/i)).toBeNull();
  });

  it("dit que rien ne partira jamais sans correspondance", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ mappings: 0 }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/No event is mapped/i)).toBeTruthy();
  });

  it("signale les conversions envoyées sans montant", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ zeroValueSent: 7 }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/7 sent with no amount/i)).toBeTruthy();
  });

  it("affiche l'envoi en pause", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ enabled: false }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText("Sending paused")).toBeTruthy();
  });
});

describe("Carte Google Ads — le lien vers l'écran complet", () => {
  it("vise l'écran du site", () => {
    renderAvecQuery(<GoogleAds />);

    expect(screen.getByRole("link", { name: /Details/i }).getAttribute("href")).toBe("/1/google-ads");
  });

  it("conserve la clé privée d'un tableau de bord partagé", () => {
    chemin.mockReturnValue("/1/a1b2c3d4e5f6/main");

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByRole("link", { name: /Details/i }).getAttribute("href")).toBe("/1/a1b2c3d4e5f6/google-ads");
  });

  it("rend sans lien quand le chemin ne porte aucun site", () => {
    chemin.mockReturnValue("/");

    renderAvecQuery(<GoogleAds />);

    // Un `<Link href={null}>` lèverait ; c'est exactement le genre de rendu qui
    // tombe en production sans qu'aucun test de logique ne s'en aperçoive.
    expect(screen.queryByRole("link", { name: /Details/i })).toBeNull();
    expect(screen.getByText("Pending")).toBeTruthy();
  });

  it("rend sans lien quand `usePathname` renvoie null", () => {
    chemin.mockReturnValue(null);

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText("Pending")).toBeTruthy();
  });
});

describe("Carte Google Ads — les valeurs limites qui font tomber un rendu", () => {
  it("rend avec tous les champs facultatifs à null", () => {
    useGetAdsHealth.mockReturnValue(
      requete({
        data: sante({ customerId: null, lastError: null, lastSentAt: null, oldestPendingAt: null, oldestOverdueBy: null }),
      })
    );

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText("Pending")).toBeTruthy();
  });

  it("rend un retard nul sans le prendre pour une absence de retard", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ oldestOverdueBy: 0 }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.queryByText(/never ran/i)).toBeNull();
    expect(screen.getByText("Pending")).toBeTruthy();
  });

  it("rend des compteurs à des valeurs extrêmes", () => {
    useGetAdsHealth.mockReturnValue(
      requete({ data: sante({ pending: 1_234_567, sent: 0, failed: 0, skipped: 0 }) })
    );

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText("Pending")).toBeTruthy();
  });

  it("rend des compteurs à zéro sans les prendre pour une absence de données", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ pending: 0, sent: 0, failed: 0, skipped: 0 }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText("Pending")).toBeTruthy();
  });
});

/**
 * Les trois états se ressemblent à l'écran et appellent des gestes OPPOSÉS :
 * brancher le compte, réessayer, ou ne rien faire et attendre. Les confondre
 * fait reconfigurer un module qui marchait, ou chercher une panne qui n'existe
 * pas. C'est le défaut le plus coûteux du lot, d'où trois tests qui vérifient
 * chacun la présence de SON état ET l'absence des deux autres.
 */
describe("Carte Google Ads — non configuré, en erreur et vide ne se confondent pas", () => {
  it("non configuré : invite à brancher, sans parler d'erreur", () => {
    useGetAdsHealth.mockReturnValue(requete({ data: sante({ configured: false }) }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/is not connected yet/i)).toBeTruthy();
    expect(screen.queryByText(/Could not read the Google Ads status/i)).toBeNull();
    expect(screen.queryByText(/Set up and waiting/i)).toBeNull();
  });

  it("erreur de chargement : annonce l'échec et propose de réessayer, jamais de reconfigurer", () => {
    useGetAdsHealth.mockReturnValue(requete({ error: new Error("boom réseau") }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/Could not read the Google Ads status/i)).toBeTruthy();
    expect(screen.getByText(/boom réseau/i)).toBeTruthy();
    // Le point qui compte : surtout PAS « pas encore branché » ni son bouton de
    // configuration sur un compte qui l'est parfaitement.
    expect(screen.queryByText(/is not connected yet/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /Set up Google Ads/i })).toBeNull();
  });

  it("erreur de chargement : le bouton de reprise rappelle bien la requête", () => {
    const refetch = vi.fn();
    useGetAdsHealth.mockReturnValue(requete({ error: new Error("boom réseau"), refetch }));

    renderAvecQuery(<GoogleAds />);
    // Un bouton « Réessayer » qui ne réessaie rien serait pire que pas de
    // bouton du tout : le client cliquerait sans jamais rien changer.
    fireEvent.click(screen.getByRole("button", { name: /Try Again/i }));

    expect(refetch).toHaveBeenCalled();
  });

  it("erreur sans instance d'Error : retombe sur un message générique plutôt que sur du vide", () => {
    useGetAdsHealth.mockReturnValue(requete({ error: "panne opaque" }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/An error occurred while fetching the status/i)).toBeTruthy();
    expect(screen.queryByText(/is not connected yet/i)).toBeNull();
  });

  it("configuré mais vide : dit qu'on attend, sans erreur ni invite à brancher", () => {
    useGetAdsHealth.mockReturnValue(
      requete({ data: sante({ pending: 0, sent: 0, failed: 0, skipped: 0, lastSentAt: null, oldestPendingAt: null }) })
    );

    renderAvecQuery(<GoogleAds />);

    expect(screen.getByText(/Set up and waiting/i)).toBeTruthy();
    expect(screen.queryByText(/is not connected yet/i)).toBeNull();
    expect(screen.queryByText(/Could not read the Google Ads status/i)).toBeNull();
  });

  it("chargement en cours : ni erreur, ni invite à brancher", () => {
    useGetAdsHealth.mockReturnValue(requete({ isLoading: true }));

    renderAvecQuery(<GoogleAds />);

    expect(screen.queryByText(/is not connected yet/i)).toBeNull();
    expect(screen.queryByText(/Could not read the Google Ads status/i)).toBeNull();
  });
});
