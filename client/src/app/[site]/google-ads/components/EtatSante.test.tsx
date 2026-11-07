import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdsHealth } from "@/api/google-ads";
import { EtatSante } from "./EtatSante";

// `useExtracted` vient normalement du contexte next-intl, absent en test. Le
// remplacement interpole réellement les `{clés}` : un mock qui rendrait le
// gabarit brut laisserait passer un `{count}` jamais substitué à l'écran.
vi.mock("next-intl", () => ({
  useExtracted: () => (message: string, values?: Record<string, string | number>) =>
    values ? message.replace(/\{(\w+)\}/g, (_, cle) => String(values[cle] ?? `{${cle}}`)) : message,
}));

/** Un site branché, sain, rien en attente. Chaque test n'en modifie que ce qu'il teste. */
function sante(surcharge: Partial<AdsHealth> = {}): AdsHealth {
  return {
    configured: true,
    enabled: true,
    testMode: false,
    customerId: "123-456-7890",
    mappings: 2,
    pending: 0,
    sent: 42,
    failed: 0,
    skipped: 3,
    zeroValueSent: 0,
    lastError: null,
    lastSentAt: new Date().toISOString(),
    oldestPendingAt: null,
    oldestOverdueBy: null,
    ...surcharge,
  };
}

afterEach(() => {
  // `cleanup()` plutôt que de vider le corps à la main : cette seconde façon
  // arrache les portails Radix sous les pieds de React, qui échoue ensuite à
  // démonter un composant d'un test SANS RAPPORT. Ce fichier n'ouvre aucun
  // portail aujourd'hui, donc rien ne casse : c'est une mine pour le suivant.
  cleanup();
});

describe("EtatSante — mode d'essai", () => {
  it("annonce le mode d'essai en bandeau quand il est actif", () => {
    render(<EtatSante sante={sante({ testMode: true })} />);

    // Le point qui compte : on doit lire que RIEN de réel ne part. Sans ça, le
    // client voit des compteurs qui bougent et croit ses conversions envoyées.
    expect(screen.getByText(/Test mode is on/i)).toBeTruthy();
    expect(screen.getByText(/deliberately discarded/i)).toBeTruthy();
  });

  it("n'affiche aucun bandeau de mode d'essai en envoi réel", () => {
    render(<EtatSante sante={sante({ testMode: false })} />);

    expect(screen.queryByText(/Test mode is on/i)).toBeNull();
  });
});

describe("EtatSante — zéro conversion n'est pas « non configuré »", () => {
  it("dit « rien enregistré pour l'instant » sur un site branché et vide", () => {
    render(<EtatSante sante={sante({ sent: 0, pending: 0, failed: 0, skipped: 0 })} />);

    expect(screen.getByText(/No conversion recorded yet/i)).toBeTruthy();
    // Et surtout PAS le discours du module non branché : les deux situations
    // appellent des gestes opposés.
    expect(screen.queryByText(/not connected to this site yet/i)).toBeNull();
  });

  it("dit « pas encore branché » sur un site non configuré, et rien d'autre", () => {
    render(<EtatSante sante={sante({ configured: false })} />);

    expect(screen.getByText(/not connected to this site yet/i)).toBeTruthy();
    expect(screen.queryByText(/No conversion recorded yet/i)).toBeNull();
    // Aucun compteur n'est montré : afficher « 0 envoyée » ici se lirait comme
    // une panne alors que rien n'est même branché.
    expect(screen.queryByText("Sent")).toBeNull();
  });

  it("distingue « aucune correspondance » d'un site simplement calme", () => {
    render(<EtatSante sante={sante({ mappings: 0, sent: 0, pending: 0, failed: 0, skipped: 0 })} />);

    expect(screen.getByText(/No event is mapped to a conversion action/i)).toBeTruthy();
  });
});

describe("EtatSante — les défauts qui ne lèvent aucune erreur", () => {
  it("signale un drain arrêté sur une échéance dépassée", () => {
    // 42 minutes de retard alors que le drain passe toutes les 2 minutes : un
    // ordre de grandeur réaliste, pas une valeur absurde qui passerait quoi
    // qu'on fasse au code.
    render(<EtatSante sante={sante({ pending: 7, oldestOverdueBy: 42 * 60 })} />);

    expect(screen.getByText(/the sender itself has stopped/i)).toBeTruthy();
    expect(screen.getByText(/42 min ago/i)).toBeTruthy();
  });

  it("ne crie pas au blocage sur un simple cycle de drain manqué", () => {
    // 4 minutes : deux passages du drain. C'est la valeur qui sépare vraiment
    // un hoquet d'un arrêt, donc c'est celle qui doit être testée.
    render(<EtatSante sante={sante({ pending: 3, oldestOverdueBy: 4 * 60 })} />);

    expect(screen.queryByText(/the sender itself has stopped/i)).toBeNull();
  });

  it("ne crie pas au blocage sur une file longue mais à jour", () => {
    // Douze heures d'attente, mais AUCUNE échéance dépassée : c'est l'échelle
    // de réessai exponentielle qui travaille normalement. L'ancien contrôle
    // fondé sur l'âge hurlait ici.
    const vieux = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    render(<EtatSante sante={sante({ pending: 12, oldestPendingAt: vieux, oldestOverdueBy: null })} />);

    expect(screen.queryByText(/the sender itself has stopped/i)).toBeNull();
  });

  it("expose les conversions parties sans montant", () => {
    render(<EtatSante sante={sante({ zeroValueSent: 5 })} />);

    expect(screen.getByText("5 conversions were sent without any amount")).toBeTruthy();
  });

  it("affiche la dernière erreur avec son motif", () => {
    render(
      <EtatSante
        sante={sante({
          failed: 3,
          lastError: { message: "AuthorizationError.USER_PERMISSION_DENIED", at: new Date().toISOString() },
        })}
      />
    );

    expect(screen.getByText("AuthorizationError.USER_PERMISSION_DENIED")).toBeTruthy();
  });
});
