import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../../db/postgres/postgres.js";
import { dashboards } from "../../../db/postgres/schema.js";
import { createDashboardSchema } from "./dashboardSchema.js";
import { desepinglerLesAutres } from "./epinglage.js";

export async function createDashboard(
  request: FastifyRequest<{
    Params: { siteId: string };
    Body: unknown;
  }>,
  reply: FastifyReply
) {
  const siteId = parseInt(request.params.siteId, 10);
  if (isNaN(siteId) || siteId <= 0) {
    return reply.status(400).send({ error: "Invalid site ID" });
  }

  try {
    const { name, config, pinned } = createDashboardSchema.parse(request.body);

    // Site access is enforced by the `authSite` (requireSiteAccess) preHandler.
    const result = await db.transaction(async tx => {
      const inserted = await tx
        .insert(dashboards)
        .values({
          siteId,
          userId: request.user?.id,
          name,
          config: config ?? { cards: [] },
          pinned: pinned ?? false,
        })
        .returning({ dashboardId: dashboards.dashboardId });

      if (pinned && inserted.length > 0) {
        await desepinglerLesAutres(tx, siteId, inserted[0].dashboardId);
      }
      return inserted;
    });

    if (!result || result.length === 0) {
      return reply.status(500).send({ error: "Failed to create dashboard" });
    }

    return reply.status(201).send({ success: true, dashboardId: result[0].dashboardId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: "Validation error", details: error.errors });
    }
    request.log.error({ err: error }, "Error creating dashboard");
    return reply.status(500).send({ error: "Failed to create dashboard" });
  }
}
