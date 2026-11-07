import { FastifyReply, FastifyRequest } from "fastify";
import { eq, and, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/postgres/postgres.js";
import { clickhouse } from "../../db/clickhouse/clickhouse.js";
import { userProfiles, userAliases } from "../../db/postgres/schema.js";
import { siteConfig } from "../../lib/siteConfig.js";
import { resolveVisitorUserId } from "../userId/resolveVisitorUserId.js";
import { resolveClientIp } from "./resolveClientIp.js";
import { createServiceLogger } from "../../lib/logger/logger.js";

const logger = createServiceLogger("identify-service");

// Max traits size in bytes (2KB)
const MAX_TRAITS_SIZE = 2048;

// Validation schema for identify requests
const identifyPayloadSchema = z.object({
  site_id: z.string().min(1),
  anonymous_id: z.string().min(1).max(255).optional(),
  user_id: z.string().min(1).max(255),
  ip_address: z.string().ip().optional(),
  user_agent: z.string().max(512).optional(),
  traits: z
    .record(z.unknown())
    .optional()
    .refine(
      traits => {
        if (!traits) return true;
        const size = new TextEncoder().encode(JSON.stringify(traits)).length;
        return size <= MAX_TRAITS_SIZE;
      },
      { message: `Traits must be less than ${MAX_TRAITS_SIZE} bytes (2KB)` }
    ),
  is_new_identify: z.boolean().default(true),
});

// Backfill window limits partition scanning to recent data only.
// Anonymous events older than this are unlikely to belong to the identifying user.
const BACKFILL_DAYS = 30;

// Second passage du rattachement, différé.
//
// POURQUOI (mesuré en production le 2026-08-18) : les pages vues transitent par
// une file écrite par lots (`pageviewQueue`, vidage toutes les 1 s). Or la
// personne s'identifie JUSTE APRÈS avoir navigué — c'est le moment même de la
// connexion. Les événements de cette visite ne sont donc pas encore en base
// quand la mutation part, et la mutation ne rattache rien : elle réussit, sans
// rien trouver.
//
// Conséquence : le parcours qui MÈNE à la connexion — le plus intéressant, celui
// qu'on veut justement relier au client — restait anonyme à jamais. Vérifié : en
// identifiant après écriture, le rattachement marche ; en identifiant tout de
// suite, `identified_user_id` reste vide.
//
// 15 s couvrent largement le vidage de la file (1 s) et ses à-coups. Le second
// passage est idempotent (la clause `identified_user_id = ''` exclut ce qui est
// déjà rattaché), donc sans effet quand le premier a suffi.
const BACKFILL_RETRY_MS = 15_000;

// days: null backfills the device's full history — only for explicit admin
// actions (dashboard identify), where the operator asserts the whole history
// belongs to this user and the unbounded partition scan is a one-off.
export async function backfillIdentifiedUserId(
  siteId: number,
  anonymousId: string,
  userId: string,
  days: number | null = BACKFILL_DAYS
) {
  try {
    // session_replay_metadata has no `timestamp` column; its time column is
    // `start_time`. Using `timestamp` there throws ClickHouse error 47
    // (UNKNOWN_IDENTIFIER), so map each table to its actual time column.
    const tables: Array<{ name: string; timeColumn: string }> = [
      { name: "events", timeColumn: "timestamp" },
      { name: "session_replay_events", timeColumn: "timestamp" },
      { name: "session_replay_metadata", timeColumn: "start_time" },
    ];
    for (const { name, timeColumn } of tables) {
      await clickhouse.command({
        query: `ALTER TABLE ${name} UPDATE identified_user_id = {userId: String} WHERE site_id = {siteId: UInt16} AND user_id = {anonymousId: String} AND identified_user_id = ''${
          days !== null ? ` AND ${timeColumn} >= now() - INTERVAL {days: UInt16} DAY` : ""
        }`,
        query_params: { userId, siteId, anonymousId, ...(days !== null ? { days } : {}) },
      });
    }
    logger.info({ siteId, anonymousId, userId }, "Backfilled identified_user_id in ClickHouse");
  } catch (error) {
    logger.error({ siteId, anonymousId, userId, err: error }, "Error backfilling identified_user_id");
  }
}

/** Les traits à écrire : tout ce qui n'est pas explicitement mis à `null`. */
export function traitsAEcrire(traits: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(traits).filter(([, v]) => v !== null));
}

/** Les clés dont l'appelant demande la SUPPRESSION, en les posant à `null`. */
export function traitsASupprimer(traits: Record<string, unknown>): string[] {
  return Object.entries(traits)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
}

/**
 * L'expression qui met à jour la colonne `traits` : on retire les clés mises à
 * `null`, puis on fusionne le reste.
 *
 * 🔴 CHAQUE CLÉ À RETIRER EST UN PARAMÈTRE À ELLE SEULE, jamais un tableau.
 *
 * La version précédente écrivait `traits - ${nullKeys}::text[]`. Drizzle ne
 * sérialise PAS un tableau JavaScript en littéral de tableau Postgres : il
 * développe ses éléments en une liste entre parenthèses, celle des clauses
 * `IN (…)`. La requête partait donc en `traits - ('ma_cle')::text[]`, que
 * Postgres refuse — on ne convertit pas un `text` en `text[]`. L'erreur était
 * levée à CHAQUE demande de suppression, avalée par le `catch` de l'appelant,
 * et la route répondait `success: true`. Personne ne pouvait le voir.
 *
 * Le commentaire d'origine avait d'ailleurs vu la moitié du défaut : il notait
 * que le tableau VIDE se sérialisait en `()`, et n'en concluait qu'une chose,
 * qu'il fallait sauter la clause dans ce cas. Le tableau NON vide se sérialise
 * de la même façon, et c'est ce cas-là qui compte.
 *
 * L'opérateur `jsonb - text` retire une clé. Le `::text` n'est pas décoratif :
 * sans lui, un paramètre de type indéterminé rend `jsonb - $1` ambigu, Postgres
 * ayant aussi `jsonb - integer` et `jsonb - text[]`.
 *
 * Éprouvé en production le 2026-09-19 sur le profil `epreuve-portee@veridian.site`
 * du site 3 : ajout d'un trait témoin accepté (donc le chemin d'écriture marche),
 * suppression demandée dans la foulée, trait toujours présent à la relecture.
 */
export function expressionTraits(traits: Record<string, unknown>): SQL {
  let expression: SQL = sql`${userProfiles.traits}`;
  for (const cle of traitsASupprimer(traits)) {
    expression = sql`(${expression} - ${cle}::text)`;
  }
  return sql`${expression} || ${JSON.stringify(traitsAEcrire(traits))}::jsonb`;
}

export async function handleIdentify(request: FastifyRequest, reply: FastifyReply) {
  try {
    const validationResult = identifyPayloadSchema.safeParse(request.body);

    if (!validationResult.success) {
      return reply.status(400).send({
        success: false,
        error: "Invalid payload",
        details: validationResult.error.flatten(),
      });
    }

    const { site_id, anonymous_id, user_id, traits, is_new_identify, ip_address, user_agent } = validationResult.data;

    // Get site configuration
    const siteConfiguration = await siteConfig.getConfig(site_id);
    if (!siteConfiguration) {
      return reply.status(404).send({
        success: false,
        error: "Site not found",
      });
    }

    const siteId = siteConfiguration.siteId;

    const anonymousId = await resolveVisitorUserId(
      {
        anonymousId: anonymous_id,
        ipAddress: ip_address || resolveClientIp(request, { firstPartyProxy: siteConfiguration.firstPartyProxy }),
        userAgent: user_agent || request.headers["user-agent"] || "",
      },
      siteId
    );

    // Create alias if this is a new identify call (links anonymous_id to user_id)
    if (is_new_identify) {
      // Ensure a user_profiles row exists at identify time so the user is
      // discoverable via search/inventory queries even when no traits are set,
      // and so createdAt reflects identification time rather than first setTraits.
      try {
        await db.insert(userProfiles).values({ siteId, userId: user_id }).onConflictDoNothing();
      } catch (error) {
        logger.error({ siteId, userId: user_id, err: error }, "Error creating user profile shell");
      }

      try {
        // Check if alias already exists
        const existingAlias = await db
          .select()
          .from(userAliases)
          .where(and(eq(userAliases.siteId, siteId), eq(userAliases.anonymousId, anonymousId)))
          .limit(1);

        if (existingAlias.length === 0) {
          // Create new alias
          await db.insert(userAliases).values({
            siteId,
            anonymousId,
            userId: user_id,
          });
          // Fire-and-forget: backfill identified_user_id on past anonymous events
          backfillIdentifiedUserId(siteId, anonymousId, user_id);
          // Deuxième passage, une fois la file d'ingestion vidée : sans lui, les
          // événements de la visite en cours (ceux qui mènent à la connexion)
          // ne sont jamais rattachés. Cf. BACKFILL_RETRY_MS.
          setTimeout(() => {
            void backfillIdentifiedUserId(siteId, anonymousId, user_id);
          }, BACKFILL_RETRY_MS).unref?.();
        } else if (existingAlias[0].userId !== user_id) {
          // Update alias to point to new user
          await db
            .update(userAliases)
            .set({ userId: user_id })
            .where(and(eq(userAliases.siteId, siteId), eq(userAliases.anonymousId, anonymousId)));
        }
      } catch (error) {
        // Handle unique constraint violation gracefully (race condition)
        logger.debug({ siteId, anonymousId, userId: user_id, err: error }, "Alias may already exist");
      }
    }

    // Atomic upsert: merge non-null traits and remove keys explicitly set to null.
    if (traits && Object.keys(traits).length > 0) {
      try {
        await db
          .insert(userProfiles)
          .values({ siteId, userId: user_id, traits: traitsAEcrire(traits) })
          .onConflictDoUpdate({
            target: [userProfiles.siteId, userProfiles.userId],
            set: {
              traits: expressionTraits(traits),
              updatedAt: sql`now()`,
            },
          });
      } catch (error) {
        logger.error({ siteId, userId: user_id, err: error }, "Error updating user profile");
        // 🔴 ON NE REND PLUS `success: true` SUR UN ÉCHEC D'ÉCRITURE.
        //
        // Ce `catch` renvoyait 200 : l'appelant recevait « c'est fait » alors que
        // rien n'avait bougé. Mesuré en production le 2026-09-19, c'est ainsi que
        // le défaut ci-dessus a pu vivre — la suppression d'un trait levait une
        // erreur Postgres à chaque appel, sans qu'aucun appelant ne puisse le
        // savoir. Un échec muet qui se présente comme un succès est pire qu'une
        // panne : il fabrique une mesure fausse que personne ne va vérifier.
        //
        // L'ALIAS, LUI, EST DÉJÀ POSÉ et on ne le défait pas : le rattachement du
        // parcours a réussi, c'est l'écriture des traits qui a échoué. Les deux
        // sont indépendants, et perdre le premier pour signaler le second serait
        // un échange perdant.
        //
        // Sans risque pour les appelants : le tracker du navigateur ignore la
        // réponse (best-effort), et nos relais serveur testent déjà `res.ok` et
        // journalisent — c'est justement ce qu'on veut qu'ils voient.
        return reply.status(500).send({
          success: false,
          error: "Identify accepted but traits were not written",
        });
      }
    }

    return reply.status(200).send({
      success: true,
    });
  } catch (error) {
    logger.error({ err: error }, "Error handling identify");
    return reply.status(500).send({
      success: false,
      error: "Failed to process identify",
    });
  }
}
