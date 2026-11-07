import { beforeEach, describe, expect, it, vi } from "vitest";

// Vraies requêtes drizzle contre un Postgres EN MÉMOIRE (même motif que
// apiKeyLimits.test.ts). C'est ce qui compte ici : l'invariant « au plus un
// tableau épinglé par site » vit dans une TRANSACTION, et une base simulée à
// coups de `vi.fn()` prouverait seulement que le code appelle les fonctions
// qu'on lui a demandé d'appeler. On veut savoir ce que la base contient après.
vi.mock("../../../db/postgres/postgres.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../../../db/postgres/schema.js");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  return { db, sql: client };
});

import { eq } from "drizzle-orm";
import { db, sql } from "../../../db/postgres/postgres.js";
import { dashboards } from "../../../db/postgres/schema.js";
import { createDashboard } from "./createDashboard.js";
import { updateDashboard } from "./updateDashboard.js";

const DDL = `
CREATE TABLE "dashboards" (
  "dashboard_id" serial PRIMARY KEY,
  "site_id" integer,
  "user_id" text,
  "name" text NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{"cards":[]}',
  "pinned" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
`;

function reponse() {
  const r: any = {
    codeStatut: 200,
    corps: undefined as any,
    status(code: number) {
      r.codeStatut = code;
      return r;
    },
    send(corps: any) {
      r.corps = corps;
      return r;
    },
  };
  return r;
}

function requete(siteId: number, body: unknown, dashboardId?: number) {
  return {
    params: { siteId: String(siteId), ...(dashboardId ? { dashboardId: String(dashboardId) } : {}) },
    body,
    user: { id: "u1" },
    log: { error: vi.fn() },
  } as any;
}

async function creer(siteId: number, name: string, pinned?: boolean): Promise<number> {
  const rep = reponse();
  await createDashboard(requete(siteId, { name, ...(pinned !== undefined ? { pinned } : {}) }), rep);
  expect(rep.corps?.success).toBe(true);
  return rep.corps.dashboardId as number;
}

async function epingles(siteId: number): Promise<string[]> {
  const lignes = await db.select().from(dashboards).where(eq(dashboards.siteId, siteId));
  return lignes.filter(l => l.pinned).map(l => l.name);
}

beforeEach(async () => {
  await (sql as any).exec(`DROP TABLE IF EXISTS "dashboards";`);
  await (sql as any).exec(DDL);
});

describe("Épinglage d'un tableau de bord — au plus un par site", () => {
  it("n'épingle rien par défaut", async () => {
    await creer(1, "Sans épingle");

    expect(await epingles(1)).toEqual([]);
  });

  it("épingle à la création quand on le demande", async () => {
    await creer(1, "Vue client", true);

    expect(await epingles(1)).toEqual(["Vue client"]);
  });

  it("🔴 épingler un SECOND tableau désépingle le premier", async () => {
    // La violation est PROVOQUÉE, pas supposée. Sans cette bascule, la vue
    // d'ensemble prendrait « le premier épinglé trouvé » et afficherait un
    // tableau au hasard entre deux, sans que rien ne le signale.
    await creer(1, "Ancien", true);
    await creer(1, "Nouveau", true);

    expect(await epingles(1)).toEqual(["Nouveau"]);
  });

  it("désépingle aussi quand l'épinglage passe par une mise à jour", async () => {
    await creer(1, "Ancien", true);
    const id = await creer(1, "Nouveau");

    const rep = reponse();
    await updateDashboard(requete(1, { pinned: true }, id), rep);

    expect(rep.corps).toEqual({ success: true });
    expect(await epingles(1)).toEqual(["Nouveau"]);
  });

  it("désépingle sans rien épingler d'autre quand on le demande", async () => {
    const id = await creer(1, "Seul", true);

    const rep = reponse();
    await updateDashboard(requete(1, { pinned: false }, id), rep);

    expect(await epingles(1)).toEqual([]);
  });

  it("ne touche PAS à l'épingle quand la mise à jour ne parle que du nom", async () => {
    // Le piège serait de traiter « champ absent » comme « false » : renommer un
    // tableau le ferait disparaître de la vue d'ensemble de son client.
    const id = await creer(1, "Vue client", true);

    const rep = reponse();
    await updateDashboard(requete(1, { name: "Vue client 2026" }, id), rep);

    expect(await epingles(1)).toEqual(["Vue client 2026"]);
  });

  it("🔴 l'épingle d'un site ne touche JAMAIS celle d'un autre", async () => {
    // Les tableaux de tous les clients vivent dans la même table. Un
    // désépinglage trop large effacerait la vue d'ensemble de tous les autres
    // clients d'un coup, en silence.
    await creer(1, "Client A", true);
    await creer(2, "Client B", true);

    await creer(1, "Client A bis", true);

    expect(await epingles(1)).toEqual(["Client A bis"]);
    expect(await epingles(2)).toEqual(["Client B"]);
  });

  it("refuse de modifier un tableau qui appartient à un autre site", async () => {
    const id = await creer(2, "Client B", true);

    const rep = reponse();
    await updateDashboard(requete(1, { pinned: true }, id), rep);

    expect(rep.codeStatut).toBe(403);
    expect(await epingles(2)).toEqual(["Client B"]);
  });
});
