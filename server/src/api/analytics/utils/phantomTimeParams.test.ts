import { describe, expect, it } from "vitest";
import { findPhantomTimeParams } from "./analyticsQuery.js";

/**
 * Regression guard for the silent-scope bug found on 2026-09-17.
 *
 * `?range=1d`, `?range=30d`, `?past_minutes=60` and `?timeRange=7d` all
 * returned the same 462 sessions — the entire history of the Site — because
 * none of those parameters exist and nothing rejected them. The caller cannot
 * tell a scoped answer from an unscoped one, which is the worst failure mode
 * an analytics API can have: it is wrong in a way that still looks right.
 */
describe("findPhantomTimeParams", () => {
  it("flags parameters that look like a time window but are not supported", () => {
    for (const p of [
      "range",
      "timeRange",
      "time_range",
      "period",
      "days",
      "past_minutes",
      "pastMinutes",
      "date_range",
      "dateRange",
    ]) {
      expect(findPhantomTimeParams({ [p]: "7d" }), `${p} should be rejected`).toEqual([p]);
    }
  });

  it("leaves the parameters the API actually supports alone", () => {
    expect(
      findPhantomTimeParams({
        start_date: "2026-09-01",
        end_date: "2026-09-17",
        past_minutes_start: 60,
        past_minutes_end: 0,
        time_zone: "Europe/Paris",
        filters: "[]",
      })
    ).toEqual([]);
  });

  it("does not reject the varied extras real endpoints accept", () => {
    // A blanket allow-list would have broken these working dashboard calls.
    expect(
      findPhantomTimeParams({ sortBy: "sessions", sortOrder: "desc", pageSize: 50, page: 2, queryKind: "pages" })
    ).toEqual([]);
  });

  it("reports every offending parameter, not just the first", () => {
    expect(findPhantomTimeParams({ range: "7d", period: "month" }).sort()).toEqual(["period", "range"]);
  });

  it("survives a missing or non-object query without throwing", () => {
    expect(findPhantomTimeParams(undefined)).toEqual([]);
    expect(findPhantomTimeParams(null)).toEqual([]);
    expect(findPhantomTimeParams("range=7d")).toEqual([]);
  });
});
