import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SocialButtons } from "./SocialButtons";

// Le catalogue de traductions n'est pas le sujet : `useExtracted` renvoie
// l'identité, on lit donc les libellés sources.
vi.mock("next-intl", () => ({
  useExtracted: () => (message: string) => message,
}));

// Les trois fabriques ci-dessous sont annotées `: any` À DESSEIN. Sans ça,
// TypeScript exige que chaque export simulé porte le type COMPLET de l'export
// réel — le client better-auth entier pour `authClient`, le composant Image de
// Next pour `next/image` — et le fichier ne compile plus, ce qui fait échouer
// la construction de l'image cliente, pas seulement les tests.
const signInSocial = vi.fn();
vi.mock("@/lib/auth", (): any => ({
  authClient: { signIn: { social: (...args: unknown[]) => signInSocial(...args) } },
}));

const useConfigsMock = vi.fn();
vi.mock("@/lib/configs", (): any => ({ useConfigs: () => useConfigsMock() }));

vi.mock("next/image", (): any => ({
  default: (props: Record<string, unknown>) => <img alt="" {...props} />,
}));

function withProviders(socialProviders: unknown) {
  useConfigsMock.mockReturnValue({ configs: socialProviders, isLoading: false, error: null });
}

afterEach(() => {
  document.body.innerHTML = "";
  signInSocial.mockReset();
  useConfigsMock.mockReset();
});

describe("SocialButtons", () => {
  it("n'affiche rien tant que la configuration n'est pas chargée", () => {
    withProviders(undefined);

    const { container } = render(<SocialButtons onError={() => {}} />);

    expect(container.innerHTML).toBe("");
  });

  it("n'affiche rien — séparateur compris — quand aucun provider n'est configuré", () => {
    withProviders({ socialProviders: { google: false, microsoft: false, github: false } });

    const { container } = render(<SocialButtons onError={() => {}} />);

    expect(container.innerHTML).toBe("");
  });

  it("traite l'absence de `socialProviders` comme « aucun », jamais comme « tous »", () => {
    // Le champ n'existe pas sur une instance antérieure au branchement : une
    // valeur absente ne doit pas faire apparaître des boutons qui mèneraient
    // droit à une erreur OAuth.
    withProviders({ disableSignup: true });

    const { container } = render(<SocialButtons onError={() => {}} />);

    expect(container.innerHTML).toBe("");
  });

  it("affiche exactement les providers annoncés par le serveur", () => {
    withProviders({ socialProviders: { google: true, microsoft: true, github: false } });

    render(<SocialButtons onError={() => {}} />);

    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Microsoft" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
  });

  it("lance la connexion Microsoft sur l'identifiant de provider attendu par better-auth", () => {
    // `microsoft` — et non `microsoft-entra-id` : c'est cet identifiant qui
    // détermine l'URI de rappel /api/auth/callback/microsoft déclarée côté Entra.
    withProviders({ socialProviders: { google: false, microsoft: true, github: false } });

    render(<SocialButtons onError={() => {}} />);
    screen.getByRole("button", { name: "Continue with Microsoft" }).click();

    expect(signInSocial).toHaveBeenCalledWith({ provider: "microsoft" });
  });

  it("transmet le callbackURL, et le newUserCallbackURL en mode inscription", () => {
    withProviders({ socialProviders: { google: false, microsoft: true, github: false } });

    render(<SocialButtons onError={() => {}} callbackURL="/signup?step=2" mode="signup" />);
    screen.getByRole("button", { name: "Continue with Microsoft" }).click();

    expect(signInSocial).toHaveBeenCalledWith({
      provider: "microsoft",
      callbackURL: "/signup?step=2",
      newUserCallbackURL: "/signup?step=2",
    });
  });
});
