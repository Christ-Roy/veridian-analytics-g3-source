/**
 * Une série vide ne doit produire AUCUN tracé.
 *
 * `data ?? []` passait un tableau vide à nivo, dont le générateur rend `null`
 * faute de point ; React écrivait alors littéralement `d="null"` et le
 * navigateur refusait l'attribut. Dix-huit erreurs de console par chargement
 * de la page d'accueil, une par tuile, entièrement invisibles à l'œil : le
 * tracé était vide de toute façon.
 *
 * Ce test porte sur la GARDE, pas sur le rendu de nivo : ce qui doit être vrai
 * pour toujours, c'est qu'on n'appelle pas la bibliothèque sans point à
 * tracer. Trois entrées mènent au vide et les trois sont légitimes : données
 * absentes, tableau vide, et un tableau qui ne contient que des dates futures
 * (le composant les écarte lui-même).
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SparklinesChart } from "./SparklinesChart";

vi.mock("@/lib/nivo", () => ({ useNivoTheme: () => ({}) }));
vi.mock("@nivo/line", () => ({
  ResponsiveLine: () => <div data-testid="courbe" />,
}));

const futur = "2099-01-01 00:00:00";

describe("SparklinesChart", () => {
  it("ne rend rien quand la donnée est absente", () => {
    const { container } = render(<SparklinesChart data={undefined} isHovering={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("ne rend rien sur un tableau vide", () => {
    const { container } = render(<SparklinesChart data={[]} isHovering={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("ne rend rien quand tous les points sont dans le futur", () => {
    // Le composant écarte les dates futures : le tableau part non vide et
    // arrive vide chez nivo. C'est le cas que la garde doit attraper aussi.
    const { container } = render(
      <SparklinesChart data={[{ value: 3, time: futur }]} isHovering={false} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("rend la courbe dès qu'il y a un point utilisable", () => {
    // Contrôle POSITIF : sans lui, une garde trop large rendrait tous les tests
    // ci-dessus verts en n'affichant plus jamais rien.
    const { getByTestId } = render(
      <SparklinesChart data={[{ value: 3, time: "2026-09-01 10:00:00" }]} isHovering={false} />
    );
    expect(getByTestId("courbe")).toBeTruthy();
  });
});
