import { and, eq, ne } from "drizzle-orm";
import { db } from "../../../db/postgres/postgres.js";
import { dashboards } from "../../../db/postgres/schema.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Au plus UN tableau épinglé par site.
 *
 * 🔴 L'invariant est tenu ICI, et nulle part ailleurs. Le tenir par une
 * contrainte d'unicité partielle en base aurait paru plus solide, mais une
 * contrainte REFUSE l'écriture : épingler un second tableau rendrait une erreur
 * de base de données que l'appelant devrait interpréter, alors que l'intention
 * de l'utilisateur est parfaitement claire — « celui-ci, pas l'autre ». On
 * désépingle donc les autres dans la MÊME transaction.
 *
 * Pourquoi la même transaction : entre le désépinglage et l'épinglage, une
 * lecture concurrente verrait soit deux épinglés, soit aucun. La vue d'ensemble
 * prend le premier épinglé qu'elle trouve — elle afficherait le mauvais
 * tableau, ou aucun, sans que rien ne le signale.
 */
export async function desepinglerLesAutres(tx: Transaction, siteId: number, dashboardId: number): Promise<void> {
  await tx
    .update(dashboards)
    .set({ pinned: false })
    .where(and(eq(dashboards.siteId, siteId), ne(dashboards.dashboardId, dashboardId)));
}
