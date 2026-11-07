import { sql } from "drizzle-orm";
import type { DashboardConfig } from "@rybbit/shared";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  unique,
  pgEnum,
  uuid,
} from "drizzle-orm/pg-core";

// User table (BetterAuth)
export const user = pgTable(
  "user",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    username: text(),
    email: text().notNull(),
    emailVerified: boolean().notNull(),
    image: text(),
    createdAt: timestamp({ mode: "string" }).notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    role: text().default("user").notNull(),
    displayUsername: text(),
    banned: boolean(),
    banReason: text(),
    banExpires: timestamp({ mode: "string" }),
    // deprecated
    stripeCustomerId: text(),
    // deprecated
    overMonthlyLimit: boolean().default(false),
    // deprecated
    monthlyEventCount: integer().default(0),
    sendAutoEmailReports: boolean().default(true),
    scheduledTipEmailIds: jsonb("scheduled_tip_email_ids").$type<string[]>().default([]),
    // Veridian : identifiant du compte au Hub, clé immuable de jointure (CONTRAT-HUB 3.7).
    hubUserId: text("hub_user_id"),
  },
  table => [
    unique("user_username_unique").on(table.username),
    unique("user_email_unique").on(table.email),
    unique("user_hub_user_id_unique").on(table.hubUserId),
  ]
);

// Verification table (BetterAuth)
export const verification = pgTable("verification", {
  id: text().primaryKey().notNull(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp({ mode: "string" }).notNull(),
  createdAt: timestamp({ mode: "string" }),
  updatedAt: timestamp({ mode: "string" }),
});

// Sites table
export const sites = pgTable(
  "sites",
  {
    id: text("id").$defaultFn(() => sql`encode(gen_random_bytes(6), 'hex')`),
    // deprecated - keeping as primary key for backwards compatibility
    siteId: serial("site_id").primaryKey().notNull(),
    name: text("name").notNull(),
    type: text("type").$type<"web" | "mobile" | null>(),
    domain: text("domain").notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    organizationId: text("organization_id").references(() => organization.id),
    public: boolean().default(false),
    embedEnabled: boolean("embed_enabled").default(false),
    saltUserIds: boolean().default(false),
    blockBots: boolean().default(true).notNull(),
    // Site owner declares a first-party proxy (Cloudflare Worker, CloudFront,
    // nginx, ...) fronts their tracking traffic, so forwarded headers carry the
    // real visitor IP and must win over the connecting edge IP.
    firstPartyProxy: boolean("first_party_proxy").default(false),
    excludedIPs: jsonb("excluded_ips").default([]), // Array of IP addresses/ranges to exclude
    excludedCountries: jsonb("excluded_countries").default([]), // Array of ISO country codes to exclude (e.g., ["US", "GB"])
    excludedPaths: jsonb("excluded_paths").default([]).$type<string[]>(), // Array of pathname glob patterns to exclude (e.g., ["/admin/*", "/preview"])
    excludedHostnames: jsonb("excluded_hostnames").default([]).$type<string[]>(), // Array of hostname glob patterns to exclude (e.g., ["localhost", "*.vercel.app"])
    excludedUserAgents: jsonb("excluded_user_agents").default([]).$type<string[]>(), // Array of case-insensitive user-agent substrings to exclude (e.g., ["HeadlessChrome"])
    excludedASNs: jsonb("excluded_asns").default([]).$type<string[]>(), // Array of autonomous system numbers to exclude, with or without "AS" prefix (e.g., ["AS13335", "16509"])
    excludedQueryParams: jsonb("excluded_query_params").default([]).$type<string[]>(), // Array of query param exclusions: "name" (param present) or "name=value" (value supports * glob), e.g. ["preview", "utm_source=internal-*"]
    sessionReplay: boolean().default(false),
    webVitals: boolean().default(false),
    trackErrors: boolean().default(false),
    trackOutbound: boolean().default(true),
    trackUrlParams: boolean().default(true),
    trackInitialPageView: boolean().default(true),
    trackSpaNavigation: boolean().default(true),
    trackIp: boolean().default(false),
    trackButtonClicks: boolean().default(false),
    trackCopy: boolean().default(false),
    trackFormInteractions: boolean().default(false),
    trackFormFields: boolean().default(false),
    apiKey: text("api_key"), // Format: rb_{64_hex_chars} = 67 chars total
    privateLinkKey: text("private_link_key"),
    tags: jsonb("tags").default([]).$type<string[]>(),
  },
  table => [check("sites_type_check", sql`${table.type} IS NULL OR ${table.type} IN ('web', 'mobile')`)]
);

// Active sessions table.
// DEPRECATED: session tracking moved to Redis (see services/sessions/sessionsService.ts).
// No longer read or written by the app; kept so existing deployments stay drift-free.
// Drop it once Redis-backed sessions are verified in production:
//   DROP TABLE IF EXISTS active_sessions;
export const activeSessions = pgTable("active_sessions", {
  sessionId: text("session_id").primaryKey().notNull(),
  siteId: integer("site_id"),
  userId: text("user_id"),
  startTime: timestamp("start_time").defaultNow(),
  lastActivity: timestamp("last_activity").defaultNow(),
});

export const funnels = pgTable("funnels", {
  reportId: serial("report_id").primaryKey().notNull(),
  siteId: integer("site_id").references(() => sites.siteId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  data: jsonb(),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow(),
});

export const dashboards = pgTable("dashboards", {
  dashboardId: serial("dashboard_id").primaryKey().notNull(),
  siteId: integer("site_id").references(() => sites.siteId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  config: jsonb("config").notNull().$type<DashboardConfig>().default({ cards: [] }),
  // Veridian : le tableau épinglé est celui que la VUE D'ENSEMBLE du site
  // affiche en tête. C'est le pont qui évite de coder une carte par client —
  // une carte de conversion se crée et se modifie désormais par API, sans
  // toucher au code. Au plus un épinglé par site, invariant tenu par
  // createDashboard/updateDashboard.
  pinned: boolean("pinned").default(false).notNull(),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow(),
});

// Account table (BetterAuth)
export const account = pgTable("account", {
  id: text().primaryKey().notNull(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: timestamp({ mode: "string" }),
  refreshTokenExpiresAt: timestamp({ mode: "string" }),
  scope: text(),
  password: text(),
  createdAt: timestamp({ mode: "string" }).notNull(),
  updatedAt: timestamp({ mode: "string" }).notNull(),
});

// Organization table (BetterAuth)
export const organization = pgTable(
  "organization",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    logo: text(),
    createdAt: timestamp({ mode: "string" }).notNull(),
    metadata: text(),
    stripeCustomerId: text(),
    monthlyEventCount: integer().default(0),
    overMonthlyLimit: boolean().default(false),
    approachingLimitNotifiedPeriodStart: text(),
    planOverride: text(), // Plan name override (e.g., "pro1m", "standard500k")
    customPlan: jsonb("custom_plan").$type<{
      events: number;
      members: number | null; // null = unlimited
      websites: number | null; // null = unlimited
    }>(),
  },
  table => [unique("organization_slug_unique").on(table.slug)]
);

// Member table (BetterAuth)
export const member = pgTable("member", {
  id: text().primaryKey().notNull(),
  organizationId: text()
    .notNull()
    .references(() => organization.id),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text().notNull(),
  createdAt: timestamp({ mode: "string" }).notNull(),
  // Site access restriction: false = all sites (default), true = only sites in member_site_access
  hasRestrictedSiteAccess: boolean("has_restricted_site_access").default(false).notNull(),
});

// Invitation table (BetterAuth)
export const invitation = pgTable("invitation", {
  id: text().primaryKey().notNull(),
  email: text().notNull(),
  inviterId: text().references(() => user.id, { onDelete: "set null" }),
  organizationId: text()
    .notNull()
    .references(() => organization.id),
  role: text().notNull(),
  status: text().notNull(),
  createdAt: timestamp({ mode: "string" }),
  expiresAt: timestamp({ mode: "string" }).notNull(),
  // Site access restriction for the invited member
  hasRestrictedSiteAccess: boolean("has_restricted_site_access").default(false).notNull(),
  siteIds: jsonb("site_ids").default([]).$type<number[]>(), // Array of site IDs to grant access to
  teamId: text().references(() => team.id, { onDelete: "set null" }),
});

// Member site access junction table - stores which sites a member has access to
// Only used when member.hasRestrictedSiteAccess = true
export const memberSiteAccess = pgTable(
  "member_site_access",
  {
    id: serial("id").primaryKey().notNull(),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    unique("member_site_access_unique").on(table.memberId, table.siteId),
    index("member_site_access_member_idx").on(table.memberId),
    index("member_site_access_site_idx").on(table.siteId),
  ]
);

// Team table (BetterAuth)
export const team = pgTable("team", {
  id: text().primaryKey(),
  name: text().notNull(),
  organizationId: text().notNull().references(() => organization.id, { onDelete: "cascade" }),
  createdAt: timestamp({ mode: "string" }).notNull(),
  updatedAt: timestamp({ mode: "string" }),
  // better-auth 1.7 : plafond de membres et unicité de l'appartenance.
  memberCount: integer().notNull().default(0),
});

// Team member table (BetterAuth)
export const teamMember = pgTable("teamMember", {
  id: text().primaryKey(),
  teamId: text().notNull().references(() => team.id, { onDelete: "cascade" }),
  userId: text().notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp({ mode: "string" }),
  membershipKey: text().unique(),
});

// Team site access junction table - stores which sites belong to a team
export const teamSiteAccess = pgTable(
  "team_site_access",
  {
    id: serial("id").primaryKey().notNull(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    unique("team_site_access_unique").on(table.teamId, table.siteId),
    index("team_site_access_team_idx").on(table.teamId),
    index("team_site_access_site_idx").on(table.siteId),
  ]
);

// Session table (BetterAuth)
export const session = pgTable(
  "session",
  {
    id: text().primaryKey().notNull(),
    expiresAt: timestamp({ mode: "string" }).notNull(),
    token: text().notNull(),
    createdAt: timestamp({ mode: "string" }).notNull(),
    updatedAt: timestamp({ mode: "string" }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text(),
    activeOrganizationId: text(),
    activeTeamId: text(),
  },
  table => [unique("session_token_unique").on(table.token)]
);

// API Key table (BetterAuth)
export const apiKey = pgTable("apikey", {
  id: text().primaryKey().notNull(),
  name: text(),
  start: text(),
  prefix: text(),
  key: text().notNull(),
  // A user id (configId NULL/"default") or an organization id (configId
  // "org") — polymorphic, so no FK. Cleanup happens in auth.ts's
  // deleteUser.afterDelete and afterDeleteOrganization hooks.
  referenceId: text().notNull(),
  refillInterval: integer(),
  refillAmount: integer(),
  lastRefillAt: timestamp({ mode: "string" }),
  enabled: boolean().notNull().default(true),
  rateLimitEnabled: boolean().notNull().default(false),
  rateLimitTimeWindow: integer(),
  rateLimitMax: integer(),
  requestCount: integer().notNull().default(0),
  remaining: integer(),
  lastRequest: timestamp({ mode: "string" }),
  expiresAt: timestamp({ mode: "string" }),
  createdAt: timestamp({ mode: "string" }).notNull(),
  updatedAt: timestamp({ mode: "string" }).notNull(),
  configId: text(),
  permissions: text(),
  metadata: jsonb(),
});

// OAuth provider tables for the MCP plugin (better-auth oidc-provider schema).
// Field names and nullability mirror better-auth's model definitions; tokens
// ne sont plus utilisés : le plugin MCP OAuth a été retiré en better-auth 1.7.
export const oauthApplication = pgTable("oauthApplication", {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
  icon: text(),
  metadata: text(),
  clientId: text().notNull().unique(),
  clientSecret: text(),
  redirectUrls: text().notNull(),
  type: text().notNull(),
  disabled: boolean().default(false),
  userId: text().references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp({ mode: "string" }).notNull(),
  updatedAt: timestamp({ mode: "string" }).notNull(),
});

export const oauthAccessToken = pgTable("oauthAccessToken", {
  id: text().primaryKey().notNull(),
  accessToken: text().notNull().unique(),
  refreshToken: text().unique(),
  accessTokenExpiresAt: timestamp({ mode: "string" }).notNull(),
  refreshTokenExpiresAt: timestamp({ mode: "string" }),
  clientId: text()
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text().references(() => user.id, { onDelete: "cascade" }),
  scopes: text().notNull(),
  createdAt: timestamp({ mode: "string" }).notNull(),
  updatedAt: timestamp({ mode: "string" }).notNull(),
});

export const oauthConsent = pgTable("oauthConsent", {
  id: text().primaryKey().notNull(),
  clientId: text()
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  scopes: text().notNull(),
  consentGiven: boolean().notNull(),
  createdAt: timestamp({ mode: "string" }).notNull(),
  updatedAt: timestamp({ mode: "string" }).notNull(),
});

// Goals table for tracking conversion goals
export const goals = pgTable(
  "goals",
  {
    goalId: serial("goal_id").primaryKey().notNull(),
    siteId: integer("site_id").notNull(),
    name: text("name"), // Optional, user-defined name for the goal
    goalType: text("goal_type").notNull(), // 'path', 'event', 'outbound', 'button_click', 'form_submit', or 'copy'
    // Configuration specific to the goal type
    config: jsonb("config").notNull().$type<{
      // For 'path' type
      pathPattern?: string; // e.g., "/pricing", "/product/*/view", "/docs/**"
      // For 'event' type
      eventName?: string; // e.g., "signup_completed", "file_downloaded"
      // For autocapture types ('outbound', 'button_click', 'form_submit', 'copy')
      valuePattern?: string; // e.g., "https://example.com/**", "Sign Up*"
      // Property filters (for all goal types)
      eventPropertyKey?: string; // Deprecated - use propertyFilters instead
      eventPropertyValue?: string | number | boolean; // Deprecated - use propertyFilters instead
      propertyFilters?: Array<{
        key: string;
        value: string | number | boolean;
      }>; // Array of property filters to match (all must match)
    }>(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow(),
  },
  table => [
    foreignKey({
      columns: [table.siteId],
      foreignColumns: [sites.siteId],
      name: "goals_site_id_sites_site_id_fk",
    }).onDelete("cascade"),
  ]
);

export type FeatureFlagType = "boolean" | "multivariate" | "remote_config";
export type FeatureFlagRuntime = "client" | "server" | "both";
export type ExperimentStatus = "draft" | "running" | "paused" | "completed";

export type FeatureFlagPayloadValue =
  | string
  | number
  | boolean
  | null
  | FeatureFlagPayloadValue[]
  | { [key: string]: FeatureFlagPayloadValue };

export type FeatureFlagRule = {
  field:
    | "hostname"
    | "pathname"
    | "query"
    | "referrer"
    | "language"
    | "country"
    | "region"
    | "city"
    | "device_type"
    | "user_id"
    | "trait";
  key?: string;
  operator: "equals" | "not_equals" | "contains" | "starts_with" | "ends_with" | "regex";
  value: string | number | boolean | Array<string | number | boolean>;
};

export type FeatureFlagVariant = {
  key: string;
  name?: string;
  rolloutPercentage: number;
  payload?: FeatureFlagPayloadValue;
};

export type FeatureFlagConditionSet = {
  name?: string;
  rules: FeatureFlagRule[];
  rolloutPercentage?: number;
  variants?: FeatureFlagVariant[];
  payload?: FeatureFlagPayloadValue;
};

export const featureFlags = pgTable(
  "feature_flags",
  {
    flagId: serial("flag_id").primaryKey().notNull(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),
    key: text("key").notNull(),
    description: text("description"),
    enabled: boolean("enabled").default(false).notNull(),
    runtime: text("runtime").default("client").notNull().$type<FeatureFlagRuntime>(),
    flagType: text("flag_type").default("boolean").notNull().$type<FeatureFlagType>(),
    payload: jsonb("payload").$type<FeatureFlagPayloadValue>(),
    variants: jsonb("variants").default([]).notNull().$type<FeatureFlagVariant[]>(),
    rolloutPercentage: integer("rollout_percentage").default(100).notNull(),
    rules: jsonb("rules").default([]).notNull().$type<FeatureFlagRule[]>(),
    conditionSets: jsonb("condition_sets").default([]).notNull().$type<FeatureFlagConditionSet[]>(),
    salt: text("salt")
      .default(sql`md5(random()::text || clock_timestamp()::text)`)
      .notNull(),
    version: integer("version").default(1).notNull(),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  table => [
    unique("feature_flags_site_key_unique").on(table.siteId, table.key),
    index("feature_flags_site_idx").on(table.siteId),
    check("feature_flags_rollout_check", sql`rollout_percentage >= 0 AND rollout_percentage <= 100`),
    check("feature_flags_runtime_check", sql`runtime IN ('client', 'server', 'both')`),
    check("feature_flags_type_check", sql`flag_type IN ('boolean', 'multivariate', 'remote_config')`),
  ]
);

export const experiments = pgTable(
  "experiments",
  {
    experimentId: serial("experiment_id").primaryKey().notNull(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),
    featureFlagId: integer("feature_flag_id")
      .notNull()
      .references(() => featureFlags.flagId, { onDelete: "cascade" }),
    primaryGoalId: integer("primary_goal_id").references(() => goals.goalId, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description"),
    hypothesis: text("hypothesis"),
    status: text("status").default("draft").notNull().$type<ExperimentStatus>(),
    winningVariant: text("winning_variant"),
    startedAt: timestamp("started_at", { mode: "string" }),
    endedAt: timestamp("ended_at", { mode: "string" }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  table => [
    unique("experiments_site_flag_unique").on(table.siteId, table.featureFlagId),
    index("experiments_site_idx").on(table.siteId),
    index("experiments_feature_flag_idx").on(table.featureFlagId),
    index("experiments_primary_goal_idx").on(table.primaryGoalId),
    check("experiments_status_check", sql`status IN ('draft', 'running', 'paused', 'completed')`),
  ]
);

// Telemetry table for tracking self-hosted instances
export const telemetry = pgTable("telemetry", {
  id: serial("id").primaryKey().notNull(),
  instanceId: text("instance_id").notNull(),
  timestamp: timestamp("timestamp", { mode: "string" }).notNull().defaultNow(),
  version: text("version").notNull(),
  tableCounts: jsonb("table_counts").notNull().$type<Record<string, number>>(),
  clickhouseSizeGb: real("clickhouse_size_gb").notNull(),
});

// Google Search Console connections table
export const gscConnections = pgTable("gsc_connections", {
  siteId: integer("site_id")
    .primaryKey()
    .notNull()
    .references(() => sites.siteId, { onDelete: "cascade" }),

  // OAuth tokens
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at", { mode: "string" }).notNull(),

  // Which GSC property this connection is for
  gscPropertyUrl: text("gsc_property_url").notNull(),

  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
});

// User profiles - stores identified user traits (email, name, custom fields)
export const userProfiles = pgTable(
  "user_profiles",
  {
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // The identified user ID from identify() call
    traits: jsonb("traits").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.siteId, table.userId] }),
    index("user_profiles_site_idx").on(table.siteId),
  ]
);

// User aliases - maps anonymous IDs to identified users (multi-device support)
export const userAliases = pgTable(
  "user_aliases",
  {
    id: serial("id").primaryKey().notNull(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),
    anonymousId: text("anonymous_id").notNull(), // Hash of IP+UserAgent (device fingerprint)
    userId: text("user_id").notNull(), // The identified user ID
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
  },
  (table) => [
    unique("user_aliases_site_anon_unique").on(table.siteId, table.anonymousId),
    index("user_aliases_user_idx").on(table.siteId, table.userId),
    index("user_aliases_anon_idx").on(table.siteId, table.anonymousId),
  ]
);

// Cancellation feedback for churn reduction
export const cancellationFeedback = pgTable("cancellation_feedback", {
  id: serial("id").primaryKey().notNull(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
  reason: text("reason").notNull(),
  reasonDetails: text("reason_details"),
  retentionOfferShown: text("retention_offer_shown"),
  retentionOfferAccepted: boolean("retention_offer_accepted").default(false),
  outcome: text("outcome").notNull(),
  planNameAtCancellation: text("plan_name_at_cancellation"),
  monthlyEventCountAtCancellation: integer("monthly_event_count_at_cancellation"),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
});

export const importPlatforms = ["umami", "simple_analytics", "plausible"] as const;

export const importPlatformEnum = pgEnum("import_platform_enum", importPlatforms);

export const importStatus = pgTable(
  "import_status",
  {
    importId: uuid("import_id").primaryKey().notNull().defaultRandom(),
    siteId: integer("site_id").notNull(),
    organizationId: text("organization_id").notNull(),
    platform: importPlatformEnum("platform").notNull(),
    importedEvents: integer("imported_events").notNull().default(0),
    skippedEvents: integer("skipped_events").notNull().default(0),
    invalidEvents: integer("invalid_events").notNull().default(0),
    startedAt: timestamp("started_at", { mode: "string" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "string" }),
  },
  table => [
    foreignKey({
      columns: [table.siteId],
      foreignColumns: [sites.siteId],
      name: "import_status_site_id_sites_site_id_fk",
    }),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
      name: "import_status_organization_id_organization_id_fk",
    }),
  ]
);

// ─── Module Ads (Veridian) ────────────────────────────────────────────────────
//
// Trois tables, aucune ligne modifiée dans le code d'amont : le module Ads lit
// ce qui est déjà mesuré et n'intervient jamais dans le chemin d'ingestion.
// Conception : todo/2026-08-29-conception-module-ads.md.

// Réglages Ads d'un site. Calqué sur `gscConnections` : la clé primaire EST le
// site, donc un site ne peut porter qu'un seul compte Ads, et la suppression du
// site emporte ses réglages.
//
// Aucun jeton n'est stocké ici, à dessein : les identifiants du compte
// administrateur (MCC Veridian) vivent dans la configuration serveur. Le dépôt
// ne sait pas chiffrer un secret — les jetons Search Console sont en clair juste
// au-dessus — donc multiplier les secrets par client serait un risque net.
export const adsSiteSettings = pgTable(
  "ads_site_settings",
  {
    siteId: integer("site_id")
      .primaryKey()
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),

    // Identifiant du compte Google Ads qui reçoit les conversions, SANS tirets
    // (l'API le veut ainsi ; « 256-891-1678 » serait refusé).
    customerId: text("customer_id").notNull(),

    // Un site ne renvoie rien tant qu'on ne l'a pas décidé.
    enabled: boolean("enabled").default(false).notNull(),

    // Mode d'essai : seuls les identifiants de clic préfixés `TEST_` peuvent
    // partir. Reprend le garde-fou de app-exemple (ADS_TEST_MODE) : sur un
    // environnement d'essai les identifiants Ads pointent la VRAIE campagne, donc
    // sans ce verrou un envoi de test créerait une vraie conversion attribuée à
    // un vrai clic. Le défaut est faux : la production ne doit pas y penser.
    testMode: boolean("test_mode").default(false).notNull(),

    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  table => [
    // Un compte Ads est une suite de chiffres. Le contrôle attrape à l'écriture
    // la faute la plus probable (le format à tirets copié depuis l'interface),
    // qui autrement ne se verrait qu'au premier envoi refusé par Google.
    check("ads_site_settings_customer_id_check", sql`${table.customerId} ~ '^[0-9]+$'`),
  ]
);

// Correspondance « événement métier → action de conversion Google ». Ce qui vit
// ici est du réglage client, pas du code : ajouter un événement suivi ne doit
// pas demander un déploiement.
export const adsConversionMappings = pgTable(
  "ads_conversion_mappings",
  {
    id: serial("id").primaryKey().notNull(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),

    // Nom de l'événement métier tel qu'il est ingéré (ex. `order_paid`).
    eventName: text("event_name").notNull(),

    // Identifiant NUMÉRIQUE de l'action de conversion, pas son `resourceName`
    // complet : c'est ce que l'API Data Manager attend, et le nom de ressource
    // se reconstruit à partir du couple (customer_id, id).
    conversionActionId: text("conversion_action_id").notNull(),

    // Valeur par défaut, pour les événements qui n'en portent pas (une
    // inscription vaut ce que le client décide qu'elle vaut). `numeric` et non
    // `real` : une valeur monétaire ne se stocke pas en flottant.
    defaultValue: numeric("default_value", { precision: 14, scale: 2 }),
    currency: text("currency").default("EUR").notNull(),

    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  table => [
    // Un événement métier ne peut viser qu'une action de conversion par site :
    // sinon le même achat serait compté deux fois, sans que rien ne le signale.
    unique("ads_conversion_mappings_site_event_unique").on(table.siteId, table.eventName),
    index("ads_conversion_mappings_site_idx").on(table.siteId),
    check("ads_conversion_mappings_action_id_check", sql`${table.conversionActionId} ~ '^[0-9]+$'`),
  ]
);

// Journal des conversions à envoyer. Rien ne part en direct : on écrit ici, et
// un drain vide la file. Si Google tombe ou met dix secondes, la mesure ne s'en
// aperçoit pas.
//
// 🔴 CONVENTION : tout horodatage de cette table est en UTC, et l'appelant
// l'écrit EXPLICITEMENT. Ne jamais s'en remettre au `DEFAULT now()`.
//
// Les colonnes sont des `timestamp` SANS fuseau, comme partout dans ce schéma.
// Or `now()` y écrit l'heure MURALE de la session Postgres : mesuré sur PGlite,
// deux insertions faites à la même milliseconde sous `TimeZone = 'UTC'` puis
// `'Europe/Paris'` sont enregistrées à deux heures d'écart, sans le moindre
// avertissement. Les conséquences sont silencieuses, et différentes selon la
// colonne :
//
//   - `next_attempt_at` daterait la ligne dans le futur : invisible au drain
//     pendant deux heures, puis elle repart toute seule, sans erreur nulle part ;
//   - `occurred_at` et `click_at` sont envoyés à GOOGLE et servent au contrôle
//     des 90 jours. Décalés, ils peuvent dater une conversion AVANT son propre
//     clic, ce que Google refuse — ou la faire sortir de la fenêtre. Le défaut
//     ne se verrait qu'à l'arrivée, et pas forcément.
//
// Le `DEFAULT now()` reste en place comme filet, jamais comme source.
export const adsConversionOutbox = pgTable(
  "ads_conversion_outbox",
  {
    id: serial("id").primaryKey().notNull(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),

    // Identifiant STABLE de l'événement métier (ex. l'id de commande). Il doit
    // être reproductible : c'est lui qui rend le rejeu inoffensif.
    businessEventId: text("business_event_id").notNull(),
    conversionActionId: text("conversion_action_id").notNull(),

    // Un seul identifiant de clic par ligne, et son type à côté, plutôt que
    // trois colonnes dont deux seraient toujours nulles. Raison : le client
    // Data Manager n'en envoie de toute façon qu'UN (priorité gclid > gbraid >
    // wbraid, dataManager.ts:143). Trois colonnes laisseraient représentable un
    // état qui n'existe pas — zéro identifiant, ou trois contradictoires — et il
    // faudrait un contrôle pour l'interdire. Ici l'invariant est structurel.
    //
    // 🔴 `NOT NULL` ne suffit PAS : la chaîne vide le satisfait, et elle est
    // ravageuse. `pickAdIdentifiers` (dataManager.ts) lève sur un identifiant
    // falsy, DANS la construction du message et donc AVANT tout appel réseau —
    // une seule ligne vide condamnait ainsi son lot entier (jusqu'à 200
    // conversions valides) en échec définitif. Le drain sait désormais l'écarter
    // seule, mais le `CHECK` ci-dessous refuse la ligne à la source, là où
    // l'appelant peut encore la corriger.
    clickIdType: text("click_id_type").notNull(),
    clickId: text("click_id").notNull(),

    // Instant du CLIC, distinct de `occurred_at`. La fenêtre de 90 jours de
    // Google porte sur l'âge du clic ; un clic plus vieux reçoit un 200 et n'est
    // jamais compté. Sans cette colonne, le drain ne peut pas voir qu'une ligne
    // a vieilli hors fenêtre pendant ses tentatives : une conversion écrite avec
    // un clic de 88 jours, puis retardée par quelques échecs transitoires, part
    // hors délai sans que rien ne le signale.
    //
    // Contrôler l'âge sur `occurred_at` ne marcherait pas : `occurred_at` est
    // toujours postérieur au clic, donc on sous-estimerait l'âge à chaque fois.
    // Le contrôle serait vert et faux.
    clickAt: timestamp("click_at", { mode: "string" }).notNull(),

    // Horodatage MÉTIER de la conversion (quand la commande a été payée), qui
    // n'est pas la date d'insertion : c'est lui que Google reçoit.
    occurredAt: timestamp("occurred_at", { mode: "string" }).notNull(),
    value: numeric("value", { precision: 14, scale: 2 }),
    currency: text("currency").default("EUR").notNull(),

    // Consentement AU MOMENT DE L'ÉVÉNEMENT, figé ici. Un consentement retiré
    // plus tard ne doit pas réécrire l'histoire d'un envoi déjà décidé, et un
    // consentement accordé plus tard ne doit pas débloquer un envoi refusé.
    // Mesuré : Google répond 200 à un événement marqué CONSENT_DENIED, donc le
    // blocage est chez nous ou nulle part.
    consentAdUserData: text("consent_ad_user_data").notNull(),
    consentAdPersonalization: text("consent_ad_personalization").notNull(),

    // pending → sent, failed, ou skipped. Un 429 ou un 5xx reste `pending` avec
    // une échéance repoussée.
    //
    // `failed` et `skipped` sont séparés à dessein : le premier dit « Google a
    // refusé, ou nous avons renoncé » (400/403/404 — le client Data Manager
    // classe déjà `retryable` —, message impossible à construire, budget de
    // reprises épuisé) ; le second dit « on a décidé de ne pas envoyer » —
    // consentement refusé, clic hors des 90 jours, mode d'essai avec un
    // identifiant réel, site désactivé. Les confondre ferait monter un compteur
    // d'échecs alors que rien n'est cassé, et chercher une panne qui n'existe
    // pas. Le motif est posé dans `last_error` sous forme de code stable.
    //
    // ⚠️ Le budget de reprises épuisé est un `failed`, PAS un `skipped` : c'est
    // une panne qu'on a cessé de réessayer, pas une décision métier. Ce
    // commentaire a affirmé l'inverse jusqu'au 2026-08-29, alors que le code
    // (`api/ads/outbox.ts`, motif `retry_budget_exhausted`) faisait déjà le bon
    // choix — une requête d'exploitation écrite sur cette phrase n'aurait
    // trouvé aucune ligne.
    status: text("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { mode: "string" }).defaultNow().notNull(),
    // Porte deux choses : le message d'erreur des échecs techniques, et le code
    // de motif des lignes `skipped` (`consent_denied`, `click_too_old`,
    // `test_mode_real_click`, `site_disabled`, `retry_budget_exhausted`).
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { mode: "string" }),

    // `requestId` rendu par Google : le seul fil qui permette de retrouver un
    // envoi de leur côté quand le tableau de bord Ads ne montre rien.
    googleRequestId: text("google_request_id"),

    createdAt: timestamp("created_at", { mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
  },
  table => [
    // 🔴 LA clé d'idempotence, et le cœur du dispositif. Le même triplet sert de
    // `transactionId` à Google : même un rejeu qui passerait à travers ce journal
    // ne compterait pas deux conversions. Elle est doublement gardée, ici et
    // chez Google, parce qu'une conversion comptée deux fois fausse les enchères
    // sans jamais lever d'erreur.
    unique("ads_conversion_outbox_idempotence_unique").on(
      table.siteId,
      table.businessEventId,
      table.conversionActionId
    ),

    // L'index du drain, et lui seul : les lignes en attente dont l'échéance est
    // passée. Partiel, parce que les lignes envoyées s'accumulent sans jamais
    // être relues et n'ont aucune raison de peser sur l'index.
    index("ads_conversion_outbox_drain_idx")
      .on(table.nextAttemptAt)
      .where(sql`status = 'pending'`),

    // Pour la page de diagnostic d'un site (« qu'est-ce qui est bloqué ? »).
    index("ads_conversion_outbox_site_status_idx").on(table.siteId, table.status),

    check("ads_conversion_outbox_status_check", sql`${table.status} IN ('pending', 'sent', 'failed', 'skipped')`),
    check(
      "ads_conversion_outbox_click_id_type_check",
      sql`${table.clickIdType} IN ('gclid', 'gbraid', 'wbraid')`
    ),
    // Un identifiant de clic vide passe `NOT NULL` et fait échouer la
    // construction du message chez Google. Cf. le commentaire de la colonne.
    check("ads_conversion_outbox_click_id_check", sql`${table.clickId} <> ''`),
  ]
);

// Bilan du DERNIER passage du balayage des conversions Ads, un enregistrement
// par site, écrasé à chaque passage.
//
// 🔴 Pourquoi cette table existe, alors qu'on tient déjà un journal complet.
//
// Le journal ne peut compter que ce qui y est ENTRÉ. Or le balayage écarte, et
// il écarte en amont : un événement sans consentement publicitaire n'est même
// pas cherché, un nom d'événement non couvert par une correspondance n'est
// jamais lu, un convertisseur qui n'a jamais cliqué sur une annonce ne laisse
// rien. Tout cela est LÉGITIME, et tout cela est invisible.
//
// D'où l'état que le module fabriquerait sans cette table : un site configuré,
// activé, dont chaque événement est écarté, affiche « 0 en attente, 0 envoyé ».
// C'est-à-dire exactement le même écran qu'un site sans trafic. L'administrateur
// conclut au calme, et personne ne saura jamais que la chaîne écarte tout. Le
// motif « répond OK sans rien faire », fabriqué par le module qui existe pour ne
// pas le fabriquer.
//
// Les trois états que cette table sépare, et qui se confondaient :
//
//   1. AUCUNE LIGNE           le balayage n'a jamais tourné — une tâche planifiée
//                             qui ne démarre pas n'a aucun autre témoin ;
//   2. events_examined = 0    site calme, rien à voir ;
//   3. events_examined > 0    la chaîne voit du trafic et n'en tire rien :
//      et recorded = 0        configuration cassée, à regarder.
//
// Un seul enregistrement par site : on veut le DERNIER état, pas un historique.
// Un historique demanderait une purge, un index temporel et des décisions de
// rétention, pour répondre à une question que personne ne pose devant cet écran.
// `ads_conversion_outbox` garde déjà la trace de ce qui est entré.
/**
 * Dépenses publicitaires Google Ads, par site, par jour, par campagne.
 *
 * Le ticket d'origine du module posait CINQ questions ; une seule est couverte
 * à ce jour (« quelles conversions Google a-t-il acceptées »). Les quatre
 * autres — combien a-t-on dépensé, quels visiteurs viennent de cette dépense,
 * quel chiffre d'affaires lui est attribuable, quel ROAS — reposent toutes sur
 * la même brique manquante : le COÛT. C'est elle.
 *
 * 🔴 `costMicros` en ENTIER, et pas un montant décimal. C'est l'unité que rend
 * l'API Google (millionièmes d'unité monétaire) : convertir à l'écriture ferait
 * perdre de la précision à chaque import, puis diverger des rapports Google
 * sans que rien ne le signale. La conversion se fait à la lecture, une fois.
 *
 * 🔴 LA DEVISE EST PAR LIGNE. Un compte Google Ads a la sienne, et un client
 * peut en changer. Additionner des lignes de devises différentes serait faux,
 * et sans cette colonne rien ne l'empêcherait de passer inaperçu.
 *
 * 🔴 LA CLÉ PRIMAIRE REND L'IMPORT IDEMPOTENT, et ce n'est pas un confort :
 * Google RÉVISE ses chiffres plusieurs jours après coup (clics invalides
 * retirés, conversions attribuées en retard). Un import qui ne saurait
 * qu'ajouter figerait des chiffres faux et personne ne le verrait.
 */
export const adsCostDaily = pgTable(
  "ads_cost_daily",
  {
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.siteId, { onDelete: "cascade" }),
    date: date("date").notNull(),
    campaignId: text("campaign_id").notNull(),
    campaignName: text("campaign_name").notNull(),
    customerId: text("customer_id").notNull(),
    currency: text("currency").notNull(),
    costMicros: bigint("cost_micros", { mode: "number" }).default(0).notNull(),
    impressions: bigint("impressions", { mode: "number" }).default(0).notNull(),
    clicks: bigint("clicks", { mode: "number" }).default(0).notNull(),
    conversions: numeric("conversions", { precision: 14, scale: 2 }).default("0").notNull(),
    conversionsValue: numeric("conversions_value", { precision: 14, scale: 2 }).default("0").notNull(),
    importedAt: timestamp("imported_at", { mode: "string" }).defaultNow().notNull(),
  },
  table => [
    primaryKey({ columns: [table.siteId, table.date, table.campaignId], name: "ads_cost_daily_pk" }),
    check("ads_cost_daily_customer_id_check", sql`${table.customerId} ~ '^[0-9]+$'`),
    // Un montant négatif signale un bogue d'import, pas une dépense.
    check("ads_cost_daily_cost_check", sql`${table.costMicros} >= 0`),
    index("ads_cost_daily_date_idx").on(table.date.desc(), table.siteId),
  ]
);

export const adsScanState = pgTable("ads_scan_state", {
  siteId: integer("site_id")
    .primaryKey()
    .notNull()
    .references(() => sites.siteId, { onDelete: "cascade" }),

  // 🔴 Heure murale UTC, écrite EXPLICITEMENT par l'appelant — jamais un
  // `DEFAULT now()`, qui rend l'heure murale de la SESSION Postgres. Même
  // convention que `ads_conversion_outbox`, et pour la même raison : une base
  // dont le `TimeZone` n'est pas UTC daterait la ligne de deux heures, sans
  // erreur, et l'écran afficherait un dernier passage dans le futur.
  lastRunAt: timestamp("last_run_at", { mode: "string" }).notNull(),

  // Événements mappés lus dans ClickHouse sur la fenêtre. C'est LE chiffre qui
  // distingue « site calme » de « configuration cassée ».
  eventsExamined: integer("events_examined").default(0).notNull(),
  recorded: integer("recorded").default(0).notNull(),
  alreadyKnown: integer("already_known").default(0).notNull(),
  duplicates: integer("duplicates").default(0).notNull(),

  // Les deux motifs d'écartement qui n'entrent JAMAIS dans le journal, donc que
  // rien d'autre ne peut compter.
  skippedNoConsent: integer("skipped_no_consent").default(0).notNull(),
  skippedNoClick: integer("skipped_no_click").default(0).notNull(),

  errors: integer("errors").default(0).notNull(),

  // La limite par passage a mordu : il reste des événements non vus.
  truncated: boolean("truncated").default(false).notNull(),

  // Événements personnalisés vus sur la fenêtre dont le nom n'est couvert par
  // AUCUNE correspondance, et les plus fréquents d'entre eux.
  //
  // Sans ce comptage, la panne la plus banale — une correspondance saisie
  // `order_paid` alors que le site émet `order_confirmed` — produit un écran
  // parfaitement calme. Les noms rendent le diagnostic immédiat : « voici ce que
  // ton site émet réellement ».
  unmappedEvents: integer("unmapped_events").default(0).notNull(),
  unmappedTopNames: text("unmapped_top_names"),

  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow().notNull(),
});
