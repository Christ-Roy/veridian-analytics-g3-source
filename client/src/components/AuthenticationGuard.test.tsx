// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as unknown,
  isPending: false,
  pathname: "/25/main",
  isPublicSite: false,
  isCheckingPublic: false,
  redirected: [] as string[],
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  redirect: (path: string) => {
    state.redirected.push(path);
  },
}));
vi.mock("../lib/userStore", () => ({
  userStore: () => ({ user: state.user, isPending: state.isPending }),
}));
vi.mock("../api/admin/hooks/useSites", () => ({
  useGetSiteIsPublic: () => ({ data: state.isPublicSite, isLoading: state.isCheckingPublic }),
}));

// Le module lit l'URL du Hub au chargement : celle de la production.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BACKEND_URL = "https://analytics.app.veridian.site";
});

import { AuthenticationGuard } from "./AuthenticationGuard";

const assign = vi.fn();
const HREF = "https://analytics.app.veridian.site/25/main?timeMode=day";

function clearCookies() {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

function setCookie(name: string) {
  document.cookie = `${name}=1; Path=/`;
}

beforeEach(() => {
  state.user = null;
  state.isPending = false;
  state.pathname = "/25/main";
  state.isPublicSite = false;
  state.isCheckingPublic = false;
  state.redirected = [];
  assign.mockClear();
  clearCookies();
  vi.stubGlobal("location", { href: HREF, assign, origin: "https://analytics.app.veridian.site" });
  // jsdom refuse Secure hors https : le navigateur réel l'accepte, le test retire l'attribut.
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
  vi.spyOn(document, "cookie", "set").mockImplementation(value => {
    descriptor.set!.call(document, value.replace("; Secure", ""));
  });
  vi.spyOn(document, "cookie", "get").mockImplementation(() => descriptor.get!.call(document));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AuthenticationGuard : visite sans session", () => {
  it("renvoie au Hub avec la page demandée, encodée, et note l'essai", () => {
    render(<AuthenticationGuard />);

    expect(assign).toHaveBeenCalledWith(
      `https://app.veridian.site/api/auth/bounce/prepare?next=${encodeURIComponent(HREF)}&auto=1`
    );
    expect(document.cookie).toContain("veridian-bounce-try=");
    expect(state.redirected).toEqual([]);
  });

  it("un seul essai : au retour sans session, la page de connexion et plus de rebond", () => {
    setCookie("veridian-bounce-try");

    render(<AuthenticationGuard />);

    expect(assign).not.toHaveBeenCalled();
    expect(state.redirected).toEqual(["/login"]);
  });

  it("jamais après une déconnexion explicite", () => {
    setCookie("veridian-logout");

    render(<AuthenticationGuard />);

    expect(assign).not.toHaveBeenCalled();
    expect(state.redirected).toEqual(["/login"]);
    expect(document.cookie).not.toContain("veridian-bounce-try=");
  });

  it("jamais dans une iframe", () => {
    vi.stubGlobal("top", {});

    render(<AuthenticationGuard />);

    expect(assign).not.toHaveBeenCalled();
    expect(state.redirected).toEqual(["/login"]);
  });

  it.each([
    ["un site public", () => (state.isPublicSite = true)],
    ["un lien privé", () => (state.pathname = "/25/abc123def456")],
    ["la page de connexion", () => (state.pathname = "/login")],
    ["une session encore en lecture", () => (state.isPending = true)],
    ["un contrôle public en cours", () => (state.isCheckingPublic = true)],
  ])("laisse tranquille %s", (_name, arrange) => {
    arrange();

    render(<AuthenticationGuard />);

    expect(assign).not.toHaveBeenCalled();
    expect(state.redirected).toEqual([]);
  });
});

describe("AuthenticationGuard : connexion réussie", () => {
  it("lève la déconnexion et l'essai, et ne rebondit pas", () => {
    setCookie("veridian-logout");
    setCookie("veridian-bounce-try");
    state.user = { id: "user-1" };

    render(<AuthenticationGuard />);

    expect(document.cookie).not.toContain("veridian-logout=");
    expect(document.cookie).not.toContain("veridian-bounce-try=");
    expect(assign).not.toHaveBeenCalled();
  });
});
