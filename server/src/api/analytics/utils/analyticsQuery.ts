import { FastifyReply, FastifyRequest, RouteGenericInterface } from "fastify";
import { clickhouse } from "../../../db/clickhouse/clickhouse.js";
import { processResults } from "./utils.js";

/**
 * A fully-built ClickHouse query plus its bound parameters. Handlers build
 * specs with pure functions (testable without Fastify or a live database);
 * only the executor below ever talks to ClickHouse.
 */
export interface QuerySpec {
  query: string;
  params?: Record<string, unknown>;
}

/** Carries the failed SQL so the route wrapper can log it alongside the cause. */
export class AnalyticsQueryError extends Error {
  constructor(
    readonly original: unknown,
    readonly queries: string[]
  ) {
    super("ClickHouse query failed");
    this.name = "AnalyticsQueryError";
  }
}

/**
 * Every analytics query used to run uncapped while the two custom-SQL endpoints
 * capped at 10 seconds — an all-time query on a large Site could hold a
 * ClickHouse slot indefinitely. This bound is deliberately far above the 10s the
 * user-authored endpoints allow: these queries are first-party and a legitimate
 * all-time range on a busy Site is slow, not runaway.
 */
const MAX_EXECUTION_TIME_SECONDS = 60;

export async function runAnalyticsQuery<T>(spec: QuerySpec): Promise<T[]> {
  try {
    const result = await clickhouse.query({
      query: spec.query,
      format: "JSONEachRow",
      query_params: spec.params,
      clickhouse_settings: { max_execution_time: MAX_EXECUTION_TIME_SECONDS },
    });
    return await processResults<T>(result);
  } catch (error) {
    throw new AnalyticsQueryError(error, [spec.query]);
  }
}

export async function runPaginatedQuery<T>(
  dataSpec: QuerySpec,
  countSpec: QuerySpec
): Promise<{ data: T[]; totalCount: number }> {
  const [data, countRows] = await Promise.all([
    runAnalyticsQuery<T>(dataSpec),
    runAnalyticsQuery<{ totalCount: number }>(countSpec),
  ]);
  return { data, totalCount: countRows[0]?.totalCount ?? 0 };
}

/**
 * LIMIT/OFFSET clauses from untrusted `limit`/`page` query params.
 * Count queries get no clauses; invalid or missing values fall back to
 * `defaultLimit`; page 1 (offset 0) emits no OFFSET clause.
 */
export function getPaginationStatements(
  { limit, page }: { limit?: number | string; page?: number | string },
  defaultLimit: number,
  isCountQuery = false
): { limitStatement: string; offsetStatement: string } {
  if (isCountQuery) {
    return { limitStatement: "", offsetStatement: "" };
  }

  let validatedLimit: number | null = null;
  if (limit !== undefined) {
    const parsedLimit = parseInt(String(limit), 10);
    if (!isNaN(parsedLimit) && parsedLimit > 0) {
      validatedLimit = parsedLimit;
    }
  }
  const limitStatement = `LIMIT ${validatedLimit ?? defaultLimit}`;

  let offsetStatement = "";
  if (page !== undefined) {
    const parsedPage = parseInt(String(page), 10);
    if (!isNaN(parsedPage) && parsedPage >= 1) {
      const offset = (parsedPage - 1) * (validatedLimit ?? defaultLimit);
      if (offset > 0) {
        offsetStatement = `OFFSET ${offset}`;
      }
    }
  }

  return { limitStatement, offsetStatement };
}

type AnalyticsHandler<R extends RouteGenericInterface> = (
  req: FastifyRequest<R>,
  res: FastifyReply
) => Promise<unknown>;

/**
 * Wraps a handler with the standard analytics error policy: failures log the
 * label (and the failed SQL when available) and respond 500 with
 * `Failed to fetch <label>`. The label may derive from the request.
 */
/**
 * Query params that LOOK like a time window but that this API has never
 * accepted. Silently ignoring them is the worst possible behaviour: the caller
 * believes the result is scoped, the server happily returns ALL of history, and
 * both sides agree on a number that means something else.
 *
 * Measured on 2026-09-17 against a customer Site: `?range=1d`, `?range=30d`,
 * `?past_minutes=60` and `?timeRange=7d` each returned the exact same 462
 * sessions — the full history since the Site was created. A business decision
 * was nearly taken on a figure that overstated monthly traffic threefold.
 *
 * The real parameters are `start_date`/`end_date` (and `past_minutes_start`/
 * `past_minutes_end`), see `BaseParams` in @rybbit/shared. Rejecting these
 * names is safe: no first-party client sends any of them (checked across
 * `client/src`), so the only callers affected are those already being misled.
 *
 * Deliberately NOT a strict allow-list over every query param: endpoints take
 * legitimately varied extras (sortBy, pageSize, queryKind, countries…), and a
 * blanket rejection would break working dashboards to fix a narrower bug.
 */
const PHANTOM_TIME_PARAMS = [
  "range",
  "timeRange",
  "time_range",
  "period",
  "days",
  "past_minutes",
  "pastMinutes",
  "date_range",
  "dateRange",
] as const;

/** The phantom time params present on a request, if any. `exempt` removes
 * names that THIS ROUTE legitimately owns for something other than a time
 * window (see `analyticsRoute`'s third argument). */
export function findPhantomTimeParams(query: unknown, exempt: readonly string[] = []): string[] {
  if (!query || typeof query !== "object") return [];
  const keys = new Set(Object.keys(query as Record<string, unknown>));
  return PHANTOM_TIME_PARAMS.filter((p) => keys.has(p) && !exempt.includes(p));
}

export function analyticsRoute<R extends RouteGenericInterface>(
  errorLabel: string | ((req: FastifyRequest<R>) => string),
  handler: AnalyticsHandler<R>,
  // Names from PHANTOM_TIME_PARAMS that THIS route legitimately reads for
  // something other than a time window, and must therefore not reject.
  //
  // 🔴 `retention` is the one caller of this today, with `["range"]`.
  // Measured 2026-09-28: its `range` is a validated, clamped (7-365d) cohort
  // span read directly by `getRetention.ts` and used as `{timeRange}` in the
  // SQL — it is NOT the silently-ignored "phantom" `range` this guard was
  // built for on 2026-09-17. The blanket rejection broke the Retention page
  // in production (`GET /retention?...&range=30` → 400) and the daily
  // synthetic-traffic CI (`trafic-bout-en-bout.yml`) with it, because the
  // 2026-09-17 audit ("no first-party client sends any of them, checked
  // across client/src") missed `client/src/api/analytics/hooks/
  // useGetRetention.ts`, which does send `range`. Do not widen this list for
  // convenience: every other analytics endpoint's `range`-like param really
  // is the phantom this guard exists to catch.
  exemptPhantomParams: readonly string[] = []
): AnalyticsHandler<R> {
  return async (req, res) => {
    const phantom = findPhantomTimeParams(req.query, exemptPhantomParams);
    if (phantom.length > 0) {
      req.log.warn({ phantom }, "Rejected request using unsupported time params");
      return res.status(400).send({
        error:
          `Unsupported query parameter(s): ${phantom.join(", ")}. ` +
          "This API does not scope time that way and would have returned the " +
          "full history instead — which is why this is an error and not a " +
          "silent default. Use start_date and end_date (YYYY-MM-DD), or " +
          "past_minutes_start and past_minutes_end.",
        unsupported: phantom,
        supported: ["start_date", "end_date", "past_minutes_start", "past_minutes_end"],
      });
    }

    try {
      return await handler(req, res);
    } catch (error) {
      const label = typeof errorLabel === "function" ? errorLabel(req) : errorLabel;
      if (error instanceof AnalyticsQueryError) {
        req.log.error({ err: error.original, label }, "Analytics query failed");
        for (const query of error.queries) {
          req.log.debug({ query }, "Failed analytics query");
        }
      } else {
        req.log.error({ err: error, label }, "Analytics query failed");
      }
      return res.status(500).send({ error: `Failed to fetch ${label}` });
    }
  };
}
