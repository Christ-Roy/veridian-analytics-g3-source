import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dashboard, DashboardCard } from "@rybbit/shared";
import { renderAvecQuery } from "@/test/rendu-query";
import { DashboardEpingle } from "./DashboardEpingle";

vi.mock("next-intl", () => ({
  useExtracted: () => (message: string, values?: Record<string, string | number>) =>
    values ? message.replace(/\{(\w+)\}/g, (_, cle) => String(values[cle] ?? `{${cle}}`)) : message,
}));

const chemin = vi.fn<() => string | null>(() => "/8/main");
vi.mock("next/navigation", () => ({
  usePathname: () => chemin(),
}));

const etatStore = { site: "8" as string | undefined, filters: [] as unknown[] };
vi.mock("@/lib/store", () => ({
  useStore: (selecteur: (etat: typeof etatStore) => unknown) => selecteur(etatStore),
}));

const useGetDashboards = vi.fn();
vi.mock("@/api/analytics/hooks/useDashboards", () => ({
  useGetDashboards: (...args: unknown[]) => useGetDashboards(...args),
}));

// La carte elle-même est éprouvée par la page Dashboards ; ici on veut savoir
// COMBIEN de cartes le pont monte, et avec quel site.
const cartesMontees: { siteId: number; titre: string }[] = [];
vi.mock("../../../dashboards/components/DashboardCardView", () => ({
  DashboardCardView: ({ siteId, card }: { siteId: number; card: DashboardCard }) => {
    cartesMontees.push({ siteId, titre: card.title });
    return <div data-testid="carte">{card.title}</div>;
  },
}));

function carte(surcharge: Partial<DashboardCard> = {}): DashboardCard {
  return {
    id: "c1",
    title: "Demandes de devis",
    sql: "SELECT 1",
    vizType: "stat",
    mapping: {},
    gridPos: { x: 0, y: 0, w: 4, h: 4 },
    ...surcharge,
  };
}

function tableau(surcharge: Partial<Dashboard> = {}): Dashboard {
  return {
    dashboardId: 2,
    siteId: 8,
    userId: null,
    name: "Ce que le site rapporte",
    config: { cards: [carte()] },
    pinned: true,
    createdAt: "2026-09-18T10:00:00.000Z",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...surcharge,
  };
}

function requete(surcharge: Partial<{ data: Dashboard[]; isLoading: boolean; error: unknown }> = {}) {
  return { data: undefined, isLoading: false, error: null, ...surcharge };
}

beforeEach(() => {
  chemin.mockReturnValue("/8/main");
  etatStore.site = "8";
  etatStore.filters = [];
  cartesMontees.length = 0;
  useGetDashboards.mockReturnValue(requete({ data: [tableau()] }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Pont vers le tableau épinglé — ce qu'il montre", () => {
  it("monte les cartes du tableau épinglé, pour le bon site", () => {
    renderAvecQuery(<DashboardEpingle />);

    expect(screen.getByText("Ce que le site rapporte")).toBeTruthy();
    expect(cartesMontees).toEqual([{ siteId: 8, titre: "Demandes de devis" }]);
  });

  it("choisit le tableau ÉPINGLÉ, pas le premier de la liste", () => {
    useGetDashboards.mockReturnValue(
      requete({
        data: [
          // Les titres de carte diffèrent des noms de tableau : sinon le test
          // trouverait deux fois le même texte et échouerait pour une raison
          // sans rapport avec ce qu'il éprouve.
          tableau({ dashboardId: 1, name: "Brouillon", pinned: false, config: { cards: [carte({ title: "Carte du brouillon" })] } }),
          tableau({ dashboardId: 2, name: "Vue client", pinned: true, config: { cards: [carte({ title: "Carte épinglée" })] } }),
        ],
      })
    );

    renderAvecQuery(<DashboardEpingle />);

    expect(screen.getByText("Vue client")).toBeTruthy();
    expect(screen.getByText("Carte épinglée")).toBeTruthy();
    expect(screen.queryByText("Brouillon")).toBeNull();
    expect(screen.queryByText("Carte du brouillon")).toBeNull();
  });

  it("ne laisse apparaître NI poignée de déplacement NI poignée de redimensionnement", () => {
    // La vue d'ensemble est ce que le CLIENT regarde. Une poignée de
    // redimensionnement laissée là, même sans style, est un élément qui traîne
    // dans un tableau de bord vendu — et la tentation de la tirer est immédiate.
    // La grille est montée avec `isDraggable`/`isResizable` à faux ET `static`
    // sur chaque carte ; ce test tient les deux.
    const { container } = renderAvecQuery(<DashboardEpingle />);

    // react-grid-layout rend TOUJOURS le nœud de poignée ; ce qui la neutralise
    // est la classe `react-resizable-hide` posée sur la carte, plus la feuille
    // de style `react-resizable` que le composant importe. On éprouve donc le
    // MÉCANISME, pas l'absence du nœud : vérifier l'absence rendrait le test
    // vert le jour où la classe disparaîtrait mais pas le nœud.
    const cartes = container.querySelectorAll(".react-grid-item");
    expect(cartes.length).toBeGreaterThan(0);
    for (const carte of cartes) {
      expect(carte.className).toContain("static");
      expect(carte.className).toContain("react-resizable-hide");
    }
    expect(container.querySelectorAll(".dashboard-card-drag-handle").length).toBe(0);
  });

  it("pointe vers le tableau, lien privé compris", () => {
    chemin.mockReturnValue("/8/a1b2c3d4e5f6/main");

    renderAvecQuery(<DashboardEpingle />);

    expect(screen.getByText("Details").getAttribute("href")).toBe("/8/a1b2c3d4e5f6/dashboards/2");
  });

  it("avertit que les cartes ignorent les filtres de la page", () => {
    // Un chiffre qui ne bouge pas quand son paramètre bouge ne mesure pas ce
    // paramètre. Le client qui filtre sur un pays doit savoir que cette carte,
    // elle, ne filtre pas.
    etatStore.filters = [{ parameter: "country", type: "equals", value: ["FR"] }];

    renderAvecQuery(<DashboardEpingle />);

    expect(screen.getByText("Filters not applied")).toBeTruthy();
  });

  it("ne dit rien des filtres quand il n'y en a pas", () => {
    renderAvecQuery(<DashboardEpingle />);

    expect(screen.queryByText("Filters not applied")).toBeNull();
  });
});

describe("Pont vers le tableau épinglé — ce qu'il NE montre PAS", () => {
  // 🔴 Le contrat tient en une phrase : un site sans tableau épinglé doit voir
  // la vue d'ensemble STRICTEMENT inchangée. Pas de cadre vide, pas de
  // squelette, pas d'invitation. Chacun de ces cas a été un bloc fantôme dans
  // une application un jour.
  const riens: [string, ReturnType<typeof requete>][] = [
    ["aucun tableau n'existe", requete({ data: [] })],
    ["aucun tableau n'est épinglé", requete({ data: [tableau({ pinned: false })] })],
    ["le tableau épinglé n'a aucune carte", requete({ data: [tableau({ config: { cards: [] } })] })],
    ["la lecture est en cours", requete({ isLoading: true })],
    ["la lecture échoue (site public, 403)", requete({ error: new Error("Forbidden") })],
  ];

  for (const [cas, reponse] of riens) {
    it(`ne rend rien du tout quand ${cas}`, () => {
      useGetDashboards.mockReturnValue(reponse);

      const { container } = renderAvecQuery(<DashboardEpingle />);

      expect(container.textContent).toBe("");
      expect(cartesMontees).toEqual([]);
    });
  }

  it("ne rend rien quand le site n'est pas encore connu du magasin", () => {
    etatStore.site = undefined;

    const { container } = renderAvecQuery(<DashboardEpingle />);

    expect(container.textContent).toBe("");
  });
});
