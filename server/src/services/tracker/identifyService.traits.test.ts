import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * La suppression d'un trait de profil, et l'aveu d'un échec d'écriture.
 *
 * DEUX DÉFAUTS MESURÉS EN PRODUCTION LE 2026-09-19, sur le site 3 :
 *
 *  1. `traits - ${tableau}::text[]` ne supprimait RIEN. Drizzle ne sérialise pas
 *     un tableau JavaScript en littéral de tableau Postgres, il développe ses
 *     éléments en liste entre parenthèses. `traits - ('ma_cle')::text[]` est
 *     refusé par Postgres à chaque appel.
 *  2. L'erreur était avalée et la route répondait `success: true`. C'est ce qui
 *     rendait le premier défaut invisible : l'appelant recevait « c'est fait ».
 *
 * Le contrôle qui DISCRIMINE, pour le premier : on compile l'expression et on
 * regarde les paramètres liés. Un test qui se contenterait de vérifier que la
 * requête « contient un tiret » passerait sur les deux implémentations.
 */

vi.mock("../../db/clickhouse/clickhouse.js", () => ({ clickhouse: { command: vi.fn() } }));
vi.mock("../../lib/logger/logger.js", () => ({
  createServiceLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../userId/userIdService.js", () => ({ userIdService: {} }));
vi.mock("./resolveClientIp.js", () => ({ resolveClientIp: () => "127.0.0.1" }));

const insertMock = vi.fn();
vi.mock("../../db/postgres/postgres.js", () => ({
  db: { insert: (...a: unknown[]) => insertMock(...a) },
}));
vi.mock("../../lib/siteConfig.js", () => ({
  siteConfig: { getConfig: async () => ({ siteId: 3, firstPartyProxy: false }) },
}));

const dialecte = new PgDialect();

describe("écriture des traits d'un profil", () => {
  it("lie CHAQUE clé à supprimer comme un paramètre texte, jamais comme un tableau", async () => {
    const { expressionTraits } = await import("./identifyService.js");
    const { sql, params } = dialecte.sqlToQuery(
      expressionTraits({ a_garder: "oui", a_retirer: null, aussi_retirer: null }),
    );

    // Les deux clés partent en paramètres distincts, chacune castée en `text`.
    expect(params).toContain("a_retirer");
    expect(params).toContain("aussi_retirer");
    expect(sql.match(/- \$\d+::text/g)).toHaveLength(2);

    // 🔴 L'ancienne forme, celle qui échouait : un cast vers `text[]`.
    expect(sql).not.toContain("::text[]");

    // Et la charge fusionnée ne porte QUE ce qui reste : les clés retirées
    // apparaissent en paramètre de soustraction, jamais dans le JSON fusionné.
    const charge = params.find((p) => typeof p === "string" && p.startsWith("{")) as string;
    expect(JSON.parse(charge)).toEqual({ a_garder: "oui" });
  });

  it("n'ajoute aucune soustraction quand rien n'est à supprimer", async () => {
    const { expressionTraits } = await import("./identifyService.js");
    const { sql } = dialecte.sqlToQuery(expressionTraits({ a_garder: "oui" }));
    expect(sql).not.toMatch(/- \$\d+::text/);
    expect(sql).toContain("||");
  });

  it("dit NON quand l'écriture des traits échoue, au lieu de rendre un succès", async () => {
    const { handleIdentify } = await import("./identifyService.js");
    insertMock.mockImplementation(() => {
      throw new Error("Postgres a refusé l'écriture");
    });

    const statut = vi.fn().mockReturnThis();
    const envoi = vi.fn();
    const reponse = { status: statut, send: envoi } as never;

    await handleIdentify(
      {
        // `is_new_identify: false` isole l'écriture des traits : on ne teste pas
        // ici la pose de l'alias, qui a sa propre épreuve.
        body: {
          site_id: "3",
          user_id: "cliente@exemple.fr",
          is_new_identify: false,
          traits: { origine_regie: "Google Ads" },
        },
        headers: {},
      } as never,
      reponse,
    );

    expect(statut).toHaveBeenCalledWith(500);
    expect(envoi).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
});
