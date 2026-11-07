import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SearchConsoleHeader } from "./SearchConsoleHeader";

// `useExtracted` renvoie normalement une fonction de traduction alimentée par le
// contexte next-intl. Ici on la remplace par l'identité : le test porte sur ce
// que la carte annonce au client, pas sur le catalogue de traductions.
vi.mock("next-intl", () => ({
  useExtracted: () => (message: string) => message,
}));

function renderHeader(props: Parameters<typeof SearchConsoleHeader>[0] = {}) {
  return render(
    <TooltipProvider>
      <SearchConsoleHeader {...props} />
    </TooltipProvider>
  );
}

afterEach(() => {
  // `cleanup()` et non `document.body.innerHTML = ""` : vider le corps à la main
  // arrache les portails Radix (fenêtres modales, infobulles) sous les pieds de
  // React, qui échoue ensuite à démonter un composant d'un test SANS RAPPORT
  // (« The node to be removed is not a child of this node »). Ce fichier n'ouvre
  // aucun portail aujourd'hui, donc rien ne casse : c'est une mine pour le
  // prochain test de composant à modale.
  cleanup();
});

describe("SearchConsoleHeader", () => {
  it("nomme la source des chiffres, y compris sans connexion", () => {
    renderHeader();

    expect(screen.getByText("Search Console")).toBeTruthy();
  });

  it("affiche la propriété Google reliée en retirant le préfixe sc-domain", () => {
    renderHeader({ propertyUrl: "sc-domain:site-a.fr" });

    expect(screen.getByText("site-a.fr")).toBeTruthy();
    expect(screen.queryByText("sc-domain:site-a.fr")).toBeNull();
  });

  it("laisse intacte une propriété de type préfixe d'URL", () => {
    renderHeader({ propertyUrl: "https://www.site-a.fr/" });

    expect(screen.getByText("https://www.site-a.fr/")).toBeTruthy();
  });

  it("n'affiche le bouton d'agrandissement que si le parent en fournit un", () => {
    const onToggleExpand = vi.fn();
    const { rerender } = renderHeader();

    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();

    rerender(
      <TooltipProvider>
        <SearchConsoleHeader onToggleExpand={onToggleExpand} />
      </TooltipProvider>
    );

    screen.getByRole("button", { name: "Expand" }).click();
    expect(onToggleExpand).toHaveBeenCalledOnce();
  });
});
