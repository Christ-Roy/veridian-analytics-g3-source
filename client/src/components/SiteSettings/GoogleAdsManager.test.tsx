import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAdsManager } from "./GoogleAdsManager";
import type { AdsHealth, AdsMapping, AdsSettings } from "@/api/google-ads/endpoints";

// `useExtracted` est remplacée par l'identité : le test porte sur ce que
// l'écran propose, pas sur le catalogue de traductions.
vi.mock("next-intl", () => ({
  useExtracted:
    () =>
    (message: string, values?: Record<string, string | number>) =>
      values ? message.replace(/\{(\w+)\}/g, (_, cle) => String(values[cle] ?? `{${cle}}`)) : message,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const enregistrer = vi.fn(async () => ({ success: true }));
const creer = vi.fn(async () => ({ success: true }));
const supprimer = vi.fn(async () => ({ success: true }));

let reglages: { configured: boolean; settings: AdsSettings | null } = { configured: false, settings: null };
let correspondances: { mappings: AdsMapping[] } = { mappings: [] };
let etatSante: AdsHealth | undefined;
/** L'échec de la requête de réglages, distinct d'une réponse « pas configuré ». */
let erreurReglages: unknown = null;
const rechargerReglages = vi.fn();

/** Un site branché et sain. Chaque test ne surcharge que ce qu'il éprouve. */
function santeDe(surcharge: Partial<AdsHealth> = {}): AdsHealth {
  return {
    configured: true,
    enabled: true,
    testMode: false,
    customerId: "2568911678",
    mappings: 2,
    pending: 3,
    sent: 42,
    failed: 0,
    skipped: 5,
    zeroValueSent: 0,
    lastError: null,
    lastSentAt: new Date().toISOString(),
    oldestPendingAt: new Date().toISOString(),
    oldestOverdueBy: null,
    ...surcharge,
  };
}

const CORRESPONDANCE: AdsMapping = {
  id: 7,
  eventName: "order_paid",
  conversionActionId: "987654321",
  defaultValue: "49.90",
  currency: "EUR",
  createdAt: "2026-08-29T10:00:00.000Z",
  updatedAt: "2026-08-29T10:00:00.000Z",
};

vi.mock("@/api/google-ads/hooks", () => ({
  useGetAdsSettings: () => ({
    data: erreurReglages ? undefined : reglages,
    isLoading: false,
    error: erreurReglages,
    refetch: rechargerReglages,
  }),
  useGetAdsMappings: () => ({ data: correspondances }),
  useGetAdsHealth: () => ({ data: etatSante }),
  useUpdateAdsSettings: () => ({ mutateAsync: enregistrer, isPending: false }),
  useCreateAdsMapping: () => ({ mutateAsync: creer, isPending: false }),
  useDeleteAdsMapping: () => ({ mutateAsync: supprimer }),
}));

function reglagesDe(partiels: Partial<AdsSettings>): { configured: boolean; settings: AdsSettings } {
  return {
    configured: true,
    settings: {
      siteId: 1,
      customerId: "2568911678",
      enabled: false,
      testMode: false,
      createdAt: "2026-08-29T10:00:00.000Z",
      updatedAt: "2026-08-29T10:00:00.000Z",
      ...partiels,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reglages = { configured: false, settings: null };
  correspondances = { mappings: [] };
  etatSante = undefined;
  erreurReglages = null;
});

afterEach(() => {
  // `cleanup()` et NON `document.body.innerHTML = ""` : les fenêtres de
  // confirmation sont montées dans un portail Radix. Vider le corps du document
  // à la main arrache les nœuds sous les pieds de React, qui échoue au démontage
  // suivant sur « The node to be removed is not a child of this node ». Le
  // symptôme apparaît dans un test qui n'a rien à voir avec la cause.
  cleanup();
});

describe("GoogleAdsManager — l'identifiant de compte", () => {
  it("refuse le format à tirets AVANT tout appel au serveur, et propose la valeur à coller", () => {
    reglages = { configured: false, settings: null };
    render(<GoogleAdsManager canManage />);

    fireEvent.change(screen.getByLabelText("Google Ads account ID"), { target: { value: "256-891-1678" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(enregistrer).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("2568911678");
  });

  it("annonce le format attendu avant la saisie, pas seulement après l'erreur", () => {
    render(<GoogleAdsManager canManage />);

    // Le texte d'aide est présent alors qu'aucune erreur n'a été déclenchée.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByText("Digits only, no dashes. Google Ads displays it as 123-456-7890 — enter 1234567890.")
    ).toBeTruthy();
  });

  it("enregistre un identifiant valide", () => {
    render(<GoogleAdsManager canManage />);

    fireEvent.change(screen.getByLabelText("Google Ads account ID"), { target: { value: "2568911678" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(enregistrer).toHaveBeenCalledWith({ customerId: "2568911678" });
  });
});

describe("GoogleAdsManager — l'activation de l'envoi", () => {
  it("ne déclenche RIEN au premier clic : elle demande confirmation", () => {
    reglages = reglagesDe({ enabled: false });
    render(<GoogleAdsManager canManage />);

    fireEvent.click(screen.getByRole("button", { name: "Start sending" }));

    expect(enregistrer).not.toHaveBeenCalled();
    // La fenêtre dit en clair ce que l'activation déclenche.
    expect(screen.getByText("Start sending conversions?")).toBeTruthy();
  });

  it("n'active qu'après confirmation explicite", () => {
    reglages = reglagesDe({ enabled: false });
    render(<GoogleAdsManager canManage />);

    fireEvent.click(screen.getByRole("button", { name: "Start sending" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, start sending" }));

    expect(enregistrer).toHaveBeenCalledWith({ enabled: true });
  });

  it("demande aussi confirmation pour couper l'envoi", () => {
    reglages = reglagesDe({ enabled: true });
    render(<GoogleAdsManager canManage />);

    fireEvent.click(screen.getByRole("button", { name: "Stop sending" }));
    expect(enregistrer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Yes, stop sending" }));
    expect(enregistrer).toHaveBeenCalledWith({ enabled: false });
  });

  it("laisse le bouton d'activation inerte tant qu'aucun compte n'est enregistré", () => {
    reglages = { configured: false, settings: null };
    render(<GoogleAdsManager canManage />);

    expect((screen.getByRole("button", { name: "Start sending" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("GoogleAdsManager — un utilisateur qui n'administre pas le site", () => {
  // Le serveur exige déjà l'administration du site en écriture. Ces cas
  // protègent la promesse faite à l'écran : ne pas offrir un contrôle qui
  // engage de l'argent pour finir sur un 403 au clic.
  it("ne voit AUCUN contrôle d'écriture", () => {
    reglages = reglagesDe({ enabled: false, testMode: false });
    render(<GoogleAdsManager canManage={false} />);

    expect(screen.queryByRole("button", { name: "Start sending" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop sending" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByLabelText("Google Ads account ID")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add mapping" })).toBeNull();
  });

  it("est dit à qui s'adresser, plutôt que laissé devant une absence inexpliquée", () => {
    reglages = reglagesDe({});
    render(<GoogleAdsManager canManage={false} />);

    expect(screen.getByText("Ask a site admin to change these Google Ads settings.")).toBeTruthy();
  });

  it("voit quand même l'ÉTAT : compte, activation et mode d'essai", () => {
    reglages = reglagesDe({ customerId: "2568911678", enabled: true, testMode: true });
    render(<GoogleAdsManager canManage={false} />);

    expect(screen.getByText("2568911678")).toBeTruthy();
    expect(screen.getByText("Configured")).toBeTruthy();
    // Le bandeau du mode d'essai est la réponse à « pourquoi mes conversions
    // n'arrivent pas » : le cacher à un non-administrateur créerait le problème
    // que le contrôle de rôle est censé éviter.
    expect(screen.getByText("Test mode is on")).toBeTruthy();
  });

  it("voit les correspondances existantes mais ne peut pas les supprimer", () => {
    reglages = reglagesDe({});
    correspondances = { mappings: [CORRESPONDANCE] };
    render(<GoogleAdsManager canManage={false} />);

    // La correspondance est bien à l'écran : sans ça le cas suivant passerait
    // au vert pour la mauvaise raison, une liste vide.
    expect(screen.getByText("order_paid")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete mapping" })).toBeNull();
  });

  it("laisse l'administrateur supprimer cette même correspondance", () => {
    reglages = reglagesDe({});
    correspondances = { mappings: [CORRESPONDANCE] };
    render(<GoogleAdsManager canManage />);

    fireEvent.click(screen.getByRole("button", { name: "Delete mapping" }));
    expect(supprimer).toHaveBeenCalledWith(7);
  });
});

describe("GoogleAdsManager — le mode d'essai", () => {
  it("s'annonce en bandeau permanent quand il est actif", () => {
    reglages = reglagesDe({ testMode: true, enabled: true });
    render(<GoogleAdsManager canManage />);

    // Visible sans avoir à déplier quoi que ce soit : c'est la réponse à
    // « pourquoi je ne vois aucune conversion ».
    expect(screen.getByText("Test mode is on")).toBeTruthy();
  });

  it("ne montre pas le bandeau quand le mode d'essai est éteint", () => {
    reglages = reglagesDe({ testMode: false });
    render(<GoogleAdsManager canManage />);

    expect(screen.queryByText("Test mode is on")).toBeNull();
  });

  it("demande confirmation pour sortir du mode d'essai pendant que l'envoi est actif", () => {
    reglages = reglagesDe({ testMode: true, enabled: true });
    render(<GoogleAdsManager canManage />);

    fireEvent.click(screen.getByRole("switch", { name: "Test mode" }));

    expect(enregistrer).not.toHaveBeenCalled();
    expect(screen.getByText("Leave test mode?")).toBeTruthy();
  });
});

describe("GoogleAdsManager — l'état de santé de l'envoi", () => {
  it("alerte sur un envoi arrêté, avec le retard interpolé", () => {
    // 42 minutes de retard sur l'échéance, alors que le drain passe toutes les
    // 2 minutes. Cet écran était le seul des trois à ne rien dire ici.
    reglages = reglagesDe({ enabled: true });
    etatSante = santeDe({ pending: 12, oldestOverdueBy: 42 * 60 });
    render(<GoogleAdsManager canManage />);

    expect(screen.getByText(/the sender itself has stopped/i)).toBeTruthy();
    expect(screen.getByText(/due 42 min ago/i)).toBeTruthy();
  });

  it("n'alerte PAS sur une file longue mais à jour", () => {
    // 🔴 Le faux positif qu'on a failli livrer : douze heures d'attente sans
    // AUCUNE échéance dépassée, c'est le réessai exponentiel qui travaille
    // normalement. L'indicateur fondé sur l'âge hurlait exactement ici.
    const vieux = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    reglages = reglagesDe({ enabled: true });
    etatSante = santeDe({ pending: 40, oldestPendingAt: vieux, oldestOverdueBy: null });
    render(<GoogleAdsManager canManage />);

    expect(screen.queryByText(/the sender itself has stopped/i)).toBeNull();
    // L'ancienneté reste affichée, mais comme information et en relatif.
    expect(screen.getByText(/Oldest conversion still pending/i)).toBeTruthy();
  });

  it("n'alerte pas non plus sur un simple cycle de drain manqué", () => {
    reglages = reglagesDe({ enabled: true });
    etatSante = santeDe({ pending: 3, oldestOverdueBy: 4 * 60 });
    render(<GoogleAdsManager canManage />);

    expect(screen.queryByText(/the sender itself has stopped/i)).toBeNull();
  });

  it("n'affiche JAMAIS un horodatage brut au client", () => {
    reglages = reglagesDe({ enabled: true });
    etatSante = santeDe({
      pending: 2,
      oldestPendingAt: "2026-08-29T10:00:00.000Z",
      lastError: { message: "AuthorizationError.USER_PERMISSION_DENIED", at: "2026-08-29T10:00:00.000Z" },
      failed: 3,
    });
    const { container } = render(<GoogleAdsManager canManage />);

    // La forme ISO ne doit apparaître nulle part dans le rendu : c'est elle qui
    // trahit un horodatage recopié tel quel.
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(screen.getByText("AuthorizationError.USER_PERMISSION_DENIED")).toBeTruthy();
  });

  it("nomme les compteurs comme la page et la carte", () => {
    reglages = reglagesDe({ enabled: true });
    etatSante = santeDe();
    render(<GoogleAdsManager canManage />);

    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Discarded")).toBeTruthy();
    // Le vocabulaire divergent a bien disparu, il ne cohabite pas avec le bon.
    expect(screen.queryByText("Waiting")).toBeNull();
    expect(screen.queryByText("Skipped")).toBeNull();
  });
});

describe("GoogleAdsManager — le montant d'une correspondance", () => {
  it("le formate comme la page, et non par concaténation", () => {
    reglages = reglagesDe({});
    correspondances = { mappings: [{ ...CORRESPONDANCE, defaultValue: "49.90", currency: "EUR" }] };
    render(<GoogleAdsManager canManage />);

    // `formaterMontant` rend « 49,90 € » (locale par défaut) ; la concaténation
    // rendait « 49.90 EUR ». Le test vise ce qui distingue les deux : le code
    // devise en toutes lettres ne doit plus apparaître.
    expect(screen.queryByText(/49\.90 EUR/)).toBeNull();
    expect(screen.getByText(/49/)).toBeTruthy();
  });

  it("survit à une devise que la base a laissé passer", () => {
    // `Intl.NumberFormat` LÈVE sur un code devise invalide : sans le helper
    // partagé, une saisie bancale emporterait tout l'écran de réglages.
    reglages = reglagesDe({});
    correspondances = { mappings: [{ ...CORRESPONDANCE, defaultValue: "12.00", currency: "PAS_UNE_DEVISE" }] };
    render(<GoogleAdsManager canManage />);

    expect(screen.getByText("order_paid")).toBeTruthy();
  });
});

describe("GoogleAdsManager — les trois états du chargement des réglages", () => {
  // 🔴 Ces trois cas ne se distinguent que par CE qui s'affiche. Les confondre
  // n'est pas un détail d'affichage : « pas configuré » invite à saisir un
  // identifiant, et le faire pendant une panne réseau touche à un compte qui
  // marchait.
  it("distingue une PANNE de lecture d'un site non configuré", () => {
    erreurReglages = new Error("Failed to fetch");
    render(<GoogleAdsManager canManage />);

    expect(screen.getByText("Could not read the Google Ads settings")).toBeTruthy();
    expect(screen.getByText("Failed to fetch")).toBeTruthy();
    // Et surtout : aucun formulaire vide qui inviterait à resaisir le compte.
    expect(screen.queryByLabelText("Google Ads account ID")).toBeNull();
    expect(screen.queryByText("Not set")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start sending" })).toBeNull();
  });

  it("propose de réessayer plutôt que de laisser l'écran mort", () => {
    erreurReglages = new Error("Failed to fetch");
    render(<GoogleAdsManager canManage />);

    fireEvent.click(screen.getByRole("button", { name: /Try Again/i }));
    expect(rechargerReglages).toHaveBeenCalled();
  });

  it("affiche bien le formulaire de saisie quand le site n'est PAS configuré", () => {
    // Le contrôle qui empêche le cas précédent de passer au vert pour la
    // mauvaise raison : sans lui, un écran qui ne rendrait JAMAIS le formulaire
    // satisferait les deux tests.
    reglages = { configured: false, settings: null };
    render(<GoogleAdsManager canManage />);

    expect(screen.getByLabelText("Google Ads account ID")).toBeTruthy();
    expect(screen.queryByText("Could not read the Google Ads settings")).toBeNull();
  });

  it("affiche l'état d'un site configuré, sans message d'erreur", () => {
    reglages = reglagesDe({ customerId: "2568911678" });
    render(<GoogleAdsManager canManage={false} />);

    expect(screen.getByText("2568911678")).toBeTruthy();
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.queryByText("Could not read the Google Ads settings")).toBeNull();
  });
});
