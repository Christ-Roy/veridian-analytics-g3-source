import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Rendu d'un composant CONNECTÉ (celui qui appelle `useQuery`) dans les tests.
 *
 * Le dépôt n'avait aucun fournisseur react-query de test, et c'est exactement
 * pour cette raison qu'aucun composant branché sur l'API n'était monté : les
 * tests s'arrêtaient aux composants purs, qui reçoivent leurs données en props.
 * Le trou est réel — un composant peut lever une exception AU RENDU (un
 * `.toFixed()` sur `null`, un `.map` sur `undefined`, un hook appelé sous
 * condition) sans qu'aucun test de logique ne s'en aperçoive.
 *
 * Les tests simulent en général les HOOKS (`vi.mock("@/api/google-ads")`)
 * plutôt que le réseau ; le fournisseur reste néanmoins indispensable, car les
 * composants voisins et les enfants non simulés appellent, eux, de vrais
 * `useQuery`.
 */

/**
 * Un `QueryClient` NEUF par test. Un client partagé garderait le cache d'un
 * test dans le suivant : le second passerait au vert en lisant les données du
 * premier, et rougirait le jour où on l'exécuterait seul.
 */
export function nouveauClientQuery() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Sans ça, une requête en échec est retentée en arrière-plan : le test
        // se termine, vitest signale un `unhandled rejection`, et l'échec
        // atterrit sur un fichier sans rapport.
        retry: false,
        gcTime: 0,
        staleTime: 0,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Les API de navigateur que jsdom N'IMPLÉMENTE PAS, et dont dépendent les
 * primitives d'interface partagées par toute l'application.
 *
 * C'est une CLASSE de défaut, pas un cas : le composant fautif n'est jamais
 * celui qu'on teste. `useTouchPrimary` interroge `matchMedia("(pointer:
 * coarse)")` dès qu'une infobulle Radix est montée, `ScrollArea` construit un
 * `ResizeObserver` pour savoir s'il doit afficher sa barre. Les deux le font
 * dans un effet passif : le test échoue donc AU RENDU, avec une trace qui
 * accuse un composant parfaitement correct là où la cause est l'environnement.
 * Deux rustines successives dans deux fichiers de test en auraient appelé une
 * troisième ; on pose le manque ici, une fois, pour tout le monde.
 *
 * Les valeurs sont les plus neutres possibles — pas d'écran tactile, aucun
 * redimensionnement observé — et c'est déjà ce que suppose le reste du harnais.
 */
function poserApisNavigateur() {
  if (typeof window === "undefined") return;

  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }

  if (typeof window.ResizeObserver !== "function") {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof window.ResizeObserver;
    globalThis.ResizeObserver = window.ResizeObserver;
  }
}

/** Les fournisseurs que tout écran de l'app suppose présents. */
export function AvecQuery({ client, children }: { client?: QueryClient; children: ReactNode }) {
  poserApisNavigateur();
  const queryClient = client ?? nouveauClientQuery();

  return (
    <QueryClientProvider client={queryClient}>
      {/* Radix exige un `TooltipProvider` au-dessus de toute infobulle : sans
          lui, un enfant qui en affiche une lève au rendu. */}
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

/**
 * Monte `ui` avec les fournisseurs de l'application.
 *
 * Le critère de réussite d'un test qui l'emploie n'est pas « le bon texte
 * s'affiche » mais « le rendu ne lève pas » : monter le composant suffit déjà à
 * attraper l'essentiel.
 */
export function renderAvecQuery(ui: ReactElement, options?: { client?: QueryClient }) {
  const client = options?.client ?? nouveauClientQuery();

  return {
    client,
    ...render(<AvecQuery client={client}>{ui}</AvecQuery>),
  };
}
