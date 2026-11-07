/**
 * Ce que cet écran ne doit JAMAIS faire : additionner deux devises.
 *
 * Un compte Google Ads a sa devise et un client peut en changer. Aplatir les
 * totaux en une somme donnerait un chiffre parfaitement plausible et
 * parfaitement faux — le genre de chiffre sur lequel on décide d'un budget.
 * L'API rend un total PAR DEVISE ; ces tests figent le fait que l'écran ne
 * contourne pas cette forme.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Depenses } from "./Depenses";

vi.mock("next-intl", () => ({
  useExtracted: () => (cle: string, vars?: Record<string, unknown>) =>
    vars ? Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), cle) : cle,
}));

const total = (currency: string, costMicros: number) => ({
  currency,
  costMicros,
  clicks: 10,
  impressions: 100,
});

describe("Depenses", () => {
  it("affiche un montant par devise, et pas leur somme", () => {
    render(
      <Depenses
        totaux={[total("EUR", 72_920_000), total("USD", 30_000_000)]}
        campagnes={[]}
        trafic={null}
        debut="2026-08-06"
        fin="2026-09-04"
        chargement={false}
      />
    );
    // Les deux montants sont rendus séparément. Une somme (102,92) ne doit
    // apparaître nulle part : elle mélangerait euros et dollars.
    expect(screen.getByText(/72[.,]92/)).toBeTruthy();
    expect(screen.getByText(/30[.,]00/)).toBeTruthy();
    expect(screen.queryByText(/102[.,]92/)).toBeNull();
  });

  it("dit qu'une absence de dépense est NORMALE", () => {
    // Sans ce message, un écran vide se lit comme une panne, et la question
    // « pourquoi c'est vide » coûte un aller-retour à chaque fois.
    render(<Depenses totaux={[]} campagnes={[]} trafic={null} debut="2026-08-06" fin="2026-09-04" chargement={false} />);
    expect(screen.getByText(/normal/i)).toBeTruthy();
  });

  it("annonce ses bornes, aujourd'hui exclu", () => {
    // Le jour en cours est partiel chez Google : l'inclure ferait afficher une
    // dépense qui baisse d'heure en heure. L'écran doit dire pourquoi il
    // s'arrête hier, sinon le manque se lit comme un défaut d'import.
    const { container } = render(
      <Depenses totaux={[total("EUR", 1_000_000)]} campagnes={[]} trafic={null} debut="2026-08-06" fin="2026-09-04" chargement={false} />
    );
    // ⚠️ Le simulacre de `useExtracted` rend la CLÉ anglaise, pas la traduction :
    // ces tests portent sur le composant, pas sur le catalogue. Chercher le
    // texte français ferait échouer un rendu parfaitement juste.
    // Et on lit `container.textContent` plutôt que `screen` : les deux bornes
    // sont dans le même nœud, mais `getByText` remonte aussi ses ancêtres.
    expect(container.textContent).toContain("2026-08-06 to 2026-09-04, excluding today");
  });

  it("liste les campagnes avec leur propre devise", () => {
    render(
      <Depenses
        totaux={[total("EUR", 5_000_000)]}
        campagnes={[
          { ...total("EUR", 4_000_000), campaignId: "1", campaignName: "Marque", conversions: 3, conversionsValue: 120 },
          { ...total("EUR", 1_000_000), campaignId: "2", campaignName: "", conversions: 0, conversionsValue: 0 },
        ]}
        trafic={null}
        debut="2026-08-06"
        fin="2026-09-04"
        chargement={false}
      />
    );
    expect(screen.getByText("Marque")).toBeTruthy();
    // Une campagne sans nom retombe sur son identifiant : une ligne vide ne
    // permettrait pas de la retrouver dans Google Ads.
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("montre un squelette pendant le chargement, pas un zéro", () => {
    // Un « 0 € » affiché pendant le chargement se lit comme « rien dépensé »,
    // ce qui est une information, et fausse.
    const { container } = render(
      <Depenses totaux={[]} campagnes={[]} trafic={null} debut="2026-08-06" fin="2026-09-04" chargement={true} />
    );
    // Le composant Skeleton du dépôt ne pose pas d'attribut `data-slot` : il se
    // reconnaît à sa classe d'animation. Viser un attribut qu'il n'a pas ferait
    // un test qui passe au vert le jour où le squelette disparaîtrait.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    // `container` et non `screen` : ce projet ne configure pas le nettoyage
    // automatique de testing-library, donc `screen` voit encore le DOM des
    // rendus précédents du même fichier. Une assertion sur `screen` y échoue
    // pour une raison qui n'a rien à voir avec ce qu'elle croit mesurer.
    expect(container.textContent).not.toMatch(/No spend recorded/);
  });

  it("dit qu'un trafic payé n'a produit AUCUNE action", () => {
    // C'est le constat le plus utile de cet écran — mesuré sur site-a.fr :
    // 72,92 € pour 23 sessions payantes et zéro appel — et le plus facile à
    // confondre avec un écran vide. Il doit être écrit, pas déduit.
    const { container } = render(
      <Depenses
        totaux={[total("EUR", 72_920_000)]}
        campagnes={[]}
        trafic={{ sessionsTotal: 100, sessionsPayantes: 23, visiteursPayants: 21, actions: [] }}
        debut="2026-08-06"
        fin="2026-09-04"
        chargement={false}
      />
    );
    expect(container.textContent).toContain("produced no tracked action");
  });

  it("dit POURQUOI il n'affiche pas de ROAS", () => {
    // Aucun événement mesuré ne porte de montant. Afficher « ROAS : 0 »
    // donnerait un nombre qui a l'air calculé et ne mesure rien ; l'omettre
    // sans rien dire ferait chercher le réglage manquant.
    const { container } = render(
      <Depenses
        totaux={[total("EUR", 1_000_000)]}
        campagnes={[]}
        trafic={{ sessionsTotal: 10, sessionsPayantes: 2, visiteursPayants: 2, actions: [{ nom: "phone_click", sessions: 1, total: 1 }] }}
        debut="2026-08-06"
        fin="2026-09-04"
        chargement={false}
      />
    );
    expect(container.textContent).toContain("Return on ad spend is not shown");
    expect(container.textContent).not.toMatch(/ROAS\s*[:：]\s*0/);
  });

  it("un trafic NULL n'affiche pas « zéro visiteur »", () => {
    // 🔴 `null` veut dire « la lecture a échoué », jamais « personne n'est
    // venu ». La dépense vient de Postgres et le trafic de ClickHouse : l'un
    // peut répondre sans l'autre. Afficher « 0 visiteur venu de la publicité »
    // un jour de panne serait la pire conclusion au pire moment.
    const { container } = render(
      <Depenses
        totaux={[total("EUR", 1_000_000)]}
        campagnes={[]}
        trafic={null}
        debut="2026-08-06"
        fin="2026-09-04"
        chargement={false}
      />
    );
    expect(container.textContent).not.toContain("visits from ads");
    expect(container.textContent).not.toContain("produced no tracked action");
  });

  it("🔴 n'efface PAS le trafic payant quand la dépense manque", () => {
    // Le cas qui compte le plus : l'import de coût n'est pas passé, est en
    // retard ou a échoué, pendant que des visiteurs payés arrivent. Masquer le
    // second parce que le premier manque revient à cacher le symptôme au
    // moment où il apparaît. Constaté sur le staging le 2026-09-05.
    const { container } = render(
      <Depenses
        totaux={[]}
        campagnes={[]}
        trafic={{ sessionsTotal: 18, sessionsPayantes: 1, visiteursPayants: 1, actions: [] }}
        debut="2026-08-06"
        fin="2026-09-04"
        chargement={false}
      />
    );
    expect(container.textContent).toContain("visits from ads");
    expect(container.textContent).toContain("produced no tracked action");
    // Et l'absence de dépense reste dite, elle ne disparaît pas non plus.
    expect(container.textContent).toContain("No spend recorded");
  });

  it("garde le message court quand il n'y a NI dépense NI trafic payé", () => {
    // Contrôle du sens inverse : sans lui, la correction ci-dessus pourrait
    // faire afficher un bloc de trafic vide sur les dix-sept sites du parc qui
    // ne font aucune publicité.
    const { container } = render(
      <Depenses
        totaux={[]}
        campagnes={[]}
        trafic={{ sessionsTotal: 40, sessionsPayantes: 0, visiteursPayants: 0, actions: [] }}
        debut="2026-08-06"
        fin="2026-09-04"
        chargement={false}
      />
    );
    expect(container.textContent).toContain("No spend recorded");
    expect(container.textContent).not.toContain("visits from ads");
  });
});
