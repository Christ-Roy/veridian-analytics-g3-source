/**
 * Le fuseau que le navigateur annonce peut être inexploitable, et c'est le
 * produit ENTIER qui devient blanc.
 *
 * `Intl` rend « Etc/Unknown » quand l'environnement n'a pas de fuseau : la
 * valeur voyage dans chaque requête de données et le serveur la refuse en 400.
 * Constaté le 2026-09-03 par le balayage d'interface exécuté en CI, où les 21
 * écrans étaient en erreur sans qu'un seul message n'apparaisse.
 *
 * Ces tests portent sur le prédicat, pas sur `Intl` : la liste des noms de
 * fuseaux valides dépend du moteur, donc on vérifie qu'un nom réel passe, que
 * la sentinelle et le vide sont refusés, et qu'un nom inventé est refusé.
 */
import { describe, expect, it } from "vitest";
import { fuseauExploitable } from "./store";

describe("fuseauExploitable", () => {
  it("accepte un fuseau réel", () => {
    expect(fuseauExploitable("Europe/Paris")).toBe(true);
    expect(fuseauExploitable("UTC")).toBe(true);
  });

  it("refuse la sentinelle que rend un environnement sans fuseau", () => {
    // C'est LE cas qui a rendu 21 écrans blancs. Il n'est pas théorique.
    expect(fuseauExploitable("Etc/Unknown")).toBe(false);
  });

  it("refuse l'absence de valeur", () => {
    expect(fuseauExploitable(undefined)).toBe(false);
    expect(fuseauExploitable("")).toBe(false);
  });

  it("refuse un nom que le moteur ne connaît pas", () => {
    expect(fuseauExploitable("Mars/Olympus_Mons")).toBe(false);
  });
});
