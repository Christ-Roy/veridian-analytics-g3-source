# Index de la documentation Rybbit (locale)

193 pages, rapatriées avec le fork dans `docs/content/docs/`.
Chemins relatifs à ce dossier. Aucune connexion réseau nécessaire pour les lire.

## api

- `api/channel-performance.mdx` — **Compare Channel Performance** — Rank your acquisition channels by how well they convert — not just how much traffic they send — by combining the metric, overview, and goals endpoints with channel filters.
- `api/funnel-dropoff.mdx` — **Find Where Users Drop Off** — Chain the funnel analysis and journeys endpoints to locate the biggest leak in a conversion flow, then discover where the users who abandon actually go instead.
- `api/getting-started.mdx` — **Getting Started** — Authentication, common parameters, and best practices for the Rybbit Stats API
- `api/live-feed.mdx` — **Build a Live Visitor Feed** — Poll the live visitor count and the events endpoint to build a real-time activity stream — the foundation for a live dashboard, an internal "who's online" widget, or an alert when a key page gets traffic.
- `api/sending-events.mdx` — **Sending Events** — Track pageviews, custom events, performance, and errors from any platform using the HTTP API.
- `api/weekly-report.mdx` — **Automated Weekly Report** — Combine the overview and metric endpoints into a scheduled digest that summarizes last week's traffic, the week-over-week change, and your top pages and traffic sources.

## api/api-keys

- `api/api-keys/create-org.mdx` — **Create Organization API Key** — Programmatically create an API key owned by an organization.
- `api/api-keys/create.mdx` — **Create API Key** — Programmatically create a new API key for your account.
- `api/api-keys/delete.mdx` — **Delete API Key** — Revoke an API key by its id.
- `api/api-keys/list.mdx` — **List API Keys** — List the API keys for your account or organization.
- `api/api-keys/update.mdx` — **Update API Key** — Update an existing API key's name, enabled state, or expiry.

## api/bots

- `api/bots/by-dimension.mdx` — **Get Bots by Dimension** — Returns bot requests broken down by a dimension.
- `api/bots/overview.mdx` — **Get Bot Overview** — Returns aggregate bot-traffic metrics with a breakdown by detection layer.
- `api/bots/time-series.mdx` — **Get Bot Time Series** — Returns bot request counts over time.

## api/errors

- `api/errors/events.mdx` — **Get Error Events** — Returns individual error occurrences for a specific error message, with full context including stack traces.
- `api/errors/names.mdx` — **Get Error Names** — Returns a list of unique error messages with occurrence counts and affected session counts.
- `api/errors/time-series.mdx` — **Get Error Time Series** — Returns error occurrence counts over time for a specific error message. Useful for tracking error trends and identifying when issues started.

## api/events

- `api/events/count.mdx` — **Get Event Counts** — Returns time-bucketed event counts grouped by event type.
- `api/events/list.mdx` — **Get Events** — Returns a paginated list of events (pageviews, custom events, and outbound clicks).
- `api/events/names.mdx` — **Get Event Names** — Returns a list of unique custom event names with their occurrence counts.
- `api/events/outbound.mdx` — **Get Outbound Links** — Returns a list of outbound link clicks with their occurrence counts.
- `api/events/properties.mdx` — **Get Event Properties** — Returns property key-value pairs for a specific event name with their occurrence counts.
- `api/events/time-series.mdx` — **Get Event Time Series** — Returns time-bucketed counts for the top custom events.

## api/funnels

- `api/funnels/analyze.mdx` — **Analyze Funnel** — Analyzes a funnel and returns step-by-step conversion data. Sessions must complete steps in order (step 2 must occur after step 1, etc.).
- `api/funnels/create.mdx` — **Create Funnel** — Creates or updates a saved funnel. If `reportId` is provided, updates the existing funnel.
- `api/funnels/delete.mdx` — **Delete Funnel** — Deletes a saved funnel. This action cannot be undone.
- `api/funnels/list.mdx` — **Get Funnels** — Returns all saved funnels for a site.
- `api/funnels/step-sessions.mdx` — **Get Funnel Step Sessions** — Returns sessions that either reached or dropped off at a specific funnel step. Useful for analyzing user behavior at each stage.

## api/goals

- `api/goals/create.mdx` — **Create Goal** — Creates a new goal for tracking conversions.
- `api/goals/delete.mdx` — **Delete Goal** — Deletes a goal. This action cannot be undone.
- `api/goals/list.mdx` — **Get Goals** — Returns a paginated list of goals with their conversion metrics.
- `api/goals/sessions.mdx` — **Get Goal Sessions** — Returns sessions that completed a specific goal. Useful for analyzing the behavior of converting users.
- `api/goals/time-series.mdx` — **Get Goal Time Series** — Returns goal conversions and conversion rate over time.
- `api/goals/update.mdx` — **Update Goal** — Updates an existing goal.

## api/imports

- `api/imports/create.mdx` — **Create Import** — Starts a new data import from a supported platform.
- `api/imports/delete.mdx` — **Delete Import** — Deletes an import and all events it added. The import must be finished.
- `api/imports/events.mdx` — **Upload Import Events** — Uploads a batch of raw events to an in-progress import.
- `api/imports/list.mdx` — **List Imports** — Returns all data imports for a site with their progress counts.

## api/insights

- `api/insights/journeys.mdx` — **Get Journeys** — Returns the most common page navigation paths (user journeys) within sessions. Useful for understanding how users navigate through your site.
- `api/insights/retention.mdx` — **Get Retention** — Returns cohort-based retention analysis data. Users are grouped into cohorts based on their first visit, and retention is tracked over subsequent time periods.

## api/organizations

- `api/organizations/add-member.mdx` — **Add Organization Member** — Adds a user to an organization with a specified role. The user must already exist in the system. Requires admin or owner role in the organization.
- `api/organizations/create-site.mdx` — **Create Site** — Creates a new site within an organization. Requires admin or owner role in the organization.
- `api/organizations/event-count.mdx` — **Get Organization Event Count** — Returns daily event usage counts across an organization's sites.
- `api/organizations/invite-member.mdx` — **Invite Member** — Send an organization invitation to a user by email.
- `api/organizations/list.mdx` — **Get My Organizations** — Returns all organizations the authenticated user is a member of, including all members for each organization. Excludes subscription and billing information. Supports both session cookies and API key (Bearer token) authentication.
- `api/organizations/members.mdx` — **Get Organization Members** — Returns all members of an organization with their user details and roles. Requires membership in the organization.
- `api/organizations/remove-member.mdx` — **Remove Member** — Remove a member from an organization.
- `api/organizations/sites.mdx` — **Get Organization Sites** — Returns all sites in an organization the caller can access, with usage and subscription info.
- `api/organizations/update-member-role.mdx` — **Update Member Role** — Change an organization member's role.

## api/overview

- `api/overview/live-visitors.mdx` — **Get Live Visitors** — Returns the count of unique active visitors within the specified time window. Useful for displaying real-time visitor counts.
- `api/overview/metric.mdx` — **Get Metric** — Returns dimensional analytics data broken down by a specific parameter. Supports pagination.
- `api/overview/overview.mdx` — **Get Overview** — Returns high-level analytics metrics for a site.
- `api/overview/page-titles.mdx` — **Get Page Titles** — Returns page-view metrics aggregated by HTML page title.
- `api/overview/time-series.mdx` — **Get Overview (Time Series)** — Returns time-series analytics data broken down by configurable time buckets. Useful for charting trends over time.

## api/performance

- `api/performance/by-dimension.mdx` — **Get Performance by Dimension** — Returns performance metrics broken down by a specific dimension (page, country, browser, etc.). Useful for identifying performance issues on specific pages or for specific user segments.
- `api/performance/overview.mdx` — **Get Performance Overview** — Returns aggregate performance metrics with percentile breakdowns for all Core Web Vitals.
- `api/performance/time-series.mdx` — **Get Performance Time Series** — Returns performance metrics over time, broken down by configurable time buckets. Useful for charting performance trends.

## api/session-replay

- `api/session-replay/delete.mdx` — **Delete Session Replay** — Permanently deletes a session replay recording. Requires site write access.
- `api/session-replay/events.mdx` — **Get Session Replay Events** — Returns the rrweb events and metadata needed to reconstruct a session replay.
- `api/session-replay/list.mdx` — **Get Session Replays** — Returns recorded session replays with metadata, newest first.

## api/sessions

- `api/sessions/get.mdx` — **Get Session** — Returns detailed information about a specific session including all events and pageviews.
- `api/sessions/list.mdx` — **Get Sessions** — Returns a paginated list of sessions with their analytics data.
- `api/sessions/locations.mdx` — **Get Session Locations** — Returns aggregated session locations with coordinates for map visualization.

## api/sites

- `api/sites/delete.mdx` — **Delete Site** — Permanently deletes a site and all its associated data. This action cannot be undone. Requires admin or owner role.
- `api/sites/excluded-countries.mdx` — **Get Excluded Countries** — Returns the list of country codes that are excluded from tracking.
- `api/sites/excluded-hostnames.mdx` — **Get Excluded Hostnames** — Returns the list of hostnames excluded from analytics.
- `api/sites/excluded-ips.mdx` — **Get Excluded IPs** — Returns the list of IP addresses and CIDR ranges that are excluded from tracking.
- `api/sites/excluded-paths.mdx` — **Get Excluded Paths** — Returns the list of URL paths excluded from analytics.
- `api/sites/excluded-user-agents.mdx` — **Get Excluded User Agents** — Returns the list of user-agent patterns excluded from analytics.
- `api/sites/export-pdf.mdx` — **Export PDF Report** — Generates a downloadable PDF analytics report for a date range.
- `api/sites/get-private-link.mdx` — **Get Private Link Config** — Returns the private link key configuration. Private links allow sharing analytics with a secret key without requiring authentication.
- `api/sites/get.mdx` — **Get Site** — Returns detailed information about a specific site including its configuration.
- `api/sites/has-data.mdx` — **Get Site Has Data** — Returns whether the site has received any analytics events.
- `api/sites/is-public.mdx` — **Get Site Public Status** — Returns whether the site's analytics are publicly accessible.
- `api/sites/update-config.mdx` — **Update Site Config** — Updates site configuration settings. All fields are optional - only include the fields you want to update. Requires admin or owner role.
- `api/sites/update-private-link.mdx` — **Update Private Link Config** — Generates or revokes a private link key for sharing analytics without authentication. Requires admin or owner role.

## api/teams

- `api/teams/create.mdx` — **Create Team** — Creates a team in an organization. Requires admin/owner role.
- `api/teams/delete.mdx` — **Delete Team** — Deletes a team. Requires admin/owner role.
- `api/teams/list.mdx` — **Get Teams** — Returns the teams in an organization, with their members and accessible sites.
- `api/teams/update.mdx` — **Update Team** — Updates a team's name, members, or site access. Requires admin/owner role.

## api/user-traits

- `api/user-traits/keys.mdx` — **Get User Trait Keys** — Returns the known user trait keys with the number of users that have each.
- `api/user-traits/users.mdx` — **Get Users by Trait** — Returns users matching a specific trait key and value, with location and session metadata.
- `api/user-traits/values.mdx` — **Get User Trait Values** — Returns the distinct values for a given trait key, with user counts.

## api/users

- `api/users/info.mdx` — **Get User Info** — Returns detailed information about a specific user, including their profile traits and linked devices.
- `api/users/list.mdx` — **Get Users** — Returns a paginated list of users with their analytics data. Supports filtering by identified users only.
- `api/users/session-count.mdx` — **Get User Session Count** — Returns the number of sessions per day for a specific user. Useful for visualizing user engagement over time.

## guide

- `(docs)/account-settings.mdx` — **Account settings** — Manage your personal account settings including profile, security, and API keys
- `(docs)/autocapture.mdx` — **Autocapture** — Automatically track user interactions without writing code
- `(docs)/billing-settings.mdx` — **Billing** — Manage your subscription, billing, and usage for Rybbit Cloud
- `(docs)/bot-detection.mdx` — **Bot detection** — How Rybbit identifies and filters bot traffic from your analytics
- `(docs)/comparison.mdx` — **Comparison** — Comparison of Rybbit with other analytics solutions
- `(docs)/data-import.mdx` — **Data Import** — Import historical analytics data from other platforms
- `(docs)/definitions.mdx` — **Definitions** — Understanding Rybbit's metrics and data points
- `(docs)/embed-widget.mdx` — **Embeds** — Embed a live visitor widget or analytics dashboard on your own site
- `(docs)/experiments.mdx` — **Experiments** — Run A/B tests on feature flag variants and measure conversion lift
- `(docs)/feature-flags.mdx` — **Feature Flags** — Roll out features, serve remote config, and target variants in Rybbit
- `(docs)/filter-traffic.mdx` — **Filter traffic** — Exclude traffic by IP address, country, path, hostname, or user agent
- `(docs)/funnels.mdx` — **Funnels** — Analyze conversion through multi-step user journeys
- `(docs)/goals.mdx` — **Goals** — Track conversions from page visits, custom events, and autocaptured interactions
- `(docs)/hiding-own-traffic.mdx` — **Hiding your own traffic** — Prevent your own visits from being tracked in analytics
- `(docs)/identify-users.mdx` — **Identify Users** — How to identify and track logged-in users with Rybbit
- `(docs)/index.mdx` — **Introduction** — Introduction to Rybbit
- `(docs)/inviting-users.mdx` — **Inviting users** — Invite team members to your Rybbit organization and control their access to specific sites
- `(docs)/localhost-tracking.mdx` — **Localhost tracking** — How Rybbit handles traffic from localhost during development
- `(docs)/managing-your-installation.mdx` — **Managing your installation** — Managing your Rybbit installation
- `(docs)/organization-settings.mdx` — **Organization settings** — Manage your organization, team members, roles, and permissions
- `(docs)/roadmap.mdx` — **Roadmap** — Planned features and upcoming development for Rybbit analytics platform
- `(docs)/script-troubleshooting.mdx` — **Troubleshooting** — Common issues and solutions when the Rybbit tracking script isn't sending traffic
- `(docs)/script.mdx` — **Tracking script** — How to install and configure the Rybbit tracking script
- `(docs)/self-host-vs-cloud.mdx` — **Self-hosted vs Cloud** — Compare self-hosted and cloud versions of Rybbit
- `(docs)/self-hosting.mdx` — **Quick start** — Set up your own instance of Rybbit using our setup script
- `(docs)/site-settings.mdx` — **Site settings** — Configure your site settings including privacy options, analytics features, traffic filtering, and more
- `(docs)/tagging.mdx` — **Tagging** — How to use tags to label and segment analytics data in Rybbit
- `(docs)/teams.mdx` — **Teams** — Organize sites into teams to control which members can access them
- `(docs)/track-events.mdx` — **Track Events** — How to track custom events with Rybbit
- `(docs)/troubleshooting.mdx` — **Troubleshooting** — Docker cleanup and troubleshooting guide for Rybbit
- `(docs)/v1-migration.mdx` — **Migration to v1.0** — Breaking changes and migration steps when upgrading to Rybbit v1.0

## guide/embeds

- `(docs)/embeds/dashboard.mdx` — **Dashboard Embed** — Embed your analytics dashboard on another site
- `(docs)/embeds/widget.mdx` — **Widget Embeds** — Embed a compact live visitor widget on your own site

## guide/feature-guides

- `(docs)/feature-guides/errors.mdx` — **Errors** — Track JavaScript errors on your website
- `(docs)/feature-guides/events.mdx` — **Events** — Track custom events on your website
- `(docs)/feature-guides/globe.mdx` — **Globe** — Visualize geographic traffic distribution
- `(docs)/feature-guides/journeys.mdx` — **User Journeys** — Visualize how users navigate your site
- `(docs)/feature-guides/main-tab.mdx` — **Main Dashboard** — Overview of the main analytics dashboard
- `(docs)/feature-guides/pages-tab.mdx` — **Pages** — Analyze page performance
- `(docs)/feature-guides/performance.mdx` — **Performance** — Track Core Web Vitals and site speed
- `(docs)/feature-guides/retention.mdx` — **Retention** — Measure how many users return over time
- `(docs)/feature-guides/session-replay.mdx` — **Session Replay** — Watch recordings of user sessions
- `(docs)/feature-guides/sessions.mdx` — **Sessions** — Analyze individual user sessions
- `(docs)/feature-guides/users.mdx` — **Users** — Analyze individual users across sessions

## guide/guides

- `(docs)/guides/angular.mdx` — **Angular** — Integrate Rybbit Analytics with your Angular application
- `(docs)/guides/astro.mdx` — **Astro** — Integrate Rybbit Analytics with your Astro application for content-rich websites
- `(docs)/guides/bigcommerce.mdx` — **BigCommerce** — Integrate Rybbit Analytics with your BigCommerce store
- `(docs)/guides/bubble.mdx` — **Bubble.io** — Integrate Rybbit Analytics with your Bubble.io application to track user behavior
- `(docs)/guides/carrd.mdx` — **Carrd** — Integrate Rybbit Analytics with your Carrd site
- `(docs)/guides/contentful.mdx` — **Contentful** — Integrate Rybbit Analytics with your Contentful-powered website
- `(docs)/guides/docusaurus.mdx` — **Docusaurus** — Integrate Rybbit Analytics with your Docusaurus v2+ website
- `(docs)/guides/drupal.mdx` — **Drupal** — Integrate Rybbit Analytics with your Drupal site using the rybbit module
- `(docs)/guides/framer.mdx` — **Framer** — Integrate Rybbit Analytics with your Framer site for behavior tracking and custom events
- `(docs)/guides/ghost.mdx` — **Ghost** — Integrate Rybbit Analytics with your Ghost blog or publication
- `(docs)/guides/gitbook.mdx` — **GitBook** — Options for using Rybbit Analytics with GitBook documentation
- `(docs)/guides/google-tag-manager.mdx` — **Google Tag Manager** — Integrate Rybbit Analytics with your website using Google Tag Manager
- `(docs)/guides/hugo.mdx` — **Hugo** — Integrate Rybbit Analytics with your Hugo static site using partial templates
- `(docs)/guides/jekyll.mdx` — **Jekyll** — Integrate Rybbit Analytics with your Jekyll static site using layout files or includes
- `(docs)/guides/joomla.mdx` — **Joomla** — Integrate Rybbit Analytics with your Joomla website
- `(docs)/guides/laravel.mdx` — **Laravel** — Integrate Rybbit Analytics with your Laravel application using Blade templates
- `(docs)/guides/mintlify.mdx` — **Mintlify** — Integrate Rybbit Analytics with your Mintlify documentation site
- `(docs)/guides/prestashop.mdx` — **PrestaShop** — Integrate Rybbit Analytics with your PrestaShop store
- `(docs)/guides/sanity.mdx` — **Sanity** — Integrate Rybbit Analytics with your Sanity-powered website
- `(docs)/guides/shopify.mdx` — **Shopify** — Integrate Rybbit with your Shopify store to capture events, track conversions, and analyze user behavior.
- `(docs)/guides/squarespace.mdx` — **Squarespace** — Integrate Rybbit Analytics with your Squarespace website using the Code Injection feature.
- `(docs)/guides/strapi.mdx` — **Strapi** — Integrate Rybbit Analytics with your Strapi-powered website
- `(docs)/guides/thrivecart.mdx` — **ThriveCart** — Integrate Rybbit Analytics with your ThriveCart checkout pages
- `(docs)/guides/typo3.mdx` — **TYPO3** — Integrate Rybbit Analytics with your TYPO3 sitepackage
- `(docs)/guides/vitepress.mdx` — **VitePress** — Integrate Rybbit Analytics with your VitePress documentation site
- `(docs)/guides/webflow.mdx` — **Webflow** — Enable analytics, custom events, and more on your Webflow site with Rybbit.
- `(docs)/guides/wix.mdx` — **Wix** — Integrate Rybbit Analytics with your Wix website using custom code snippets.
- `(docs)/guides/woocommerce.mdx` — **WooCommerce** — Integrate Rybbit Analytics with your WooCommerce store
- `(docs)/guides/wordpress.mdx` — **WordPress** — Integrate Rybbit Analytics with your WordPress site

## guide/guides/react

- `(docs)/guides/react/gatsby.mdx` — **Gatsby** — Integrate Rybbit with your Gatsby site for analytics tracking
- `(docs)/guides/react/next-js.mdx` — **Next.js** — Integrate Rybbit with your Next.js application for analytics tracking
- `(docs)/guides/react/remix.mdx` — **Remix** — Integrate Rybbit with your Remix application for analytics tracking
- `(docs)/guides/react/vite-cra.mdx` — **React (Vite / CRA)** — Integrate Rybbit with your client-side React application

## guide/guides/svelte

- `(docs)/guides/svelte/sveltekit.mdx` — **SvelteKit** — Integrate Rybbit with your SvelteKit application for analytics tracking
- `(docs)/guides/svelte/vite.mdx` — **Svelte (Vite / Client-Side)** — Integrate Rybbit with your client-side Svelte application

## guide/guides/vue

- `(docs)/guides/vue/nuxt.mdx` — **Nuxt.js** — Integrate Rybbit with your Nuxt.js application for analytics tracking
- `(docs)/guides/vue/vite.mdx` — **Vue.js (Vite / Client-Side)** — Integrate Rybbit with your client-side Vue.js application

## guide/mcp

- `(docs)/mcp/claude-code.mdx` — **Claude Code** — Connect Claude Code to Rybbit's MCP server with OAuth or an API key
- `(docs)/mcp/claude-desktop.mdx` — **Claude Desktop** — Add Rybbit as a custom connector on claude.ai, Claude Desktop, and mobile
- `(docs)/mcp/codex.mdx` — **Codex** — Connect the Codex CLI to Rybbit's MCP server with OAuth or an API key
- `(docs)/mcp/cursor.mdx` — **Cursor** — Connect Cursor to Rybbit's MCP server with an API key
- `(docs)/mcp/index.mdx` — **MCP** — Let an AI assistant explore and manage your Rybbit analytics through the hosted Model Context Protocol server
- `(docs)/mcp/opencode.mdx` — **opencode** — Connect opencode to Rybbit's MCP server with OAuth or an API key
- `(docs)/mcp/vscode.mdx` — **VS Code** — Connect VS Code and Copilot agent mode to Rybbit's MCP server

## guide/proxy-guide

- `(docs)/proxy-guide/astro.mdx` — **Astro Proxy Setup** — Configure Astro middleware to proxy Rybbit tracking requests
- `(docs)/proxy-guide/caddy.mdx` — **Caddy Proxy Setup** — Configure Caddy reverse proxy to serve Rybbit tracking with automatic HTTPS
- `(docs)/proxy-guide/cloudflare-workers.mdx` — **Cloudflare Workers Proxy Setup** — Use Cloudflare Workers to proxy Rybbit tracking at the edge
- `(docs)/proxy-guide/express.mdx` — **Express.js Proxy Setup** — Configure Express.js middleware to proxy Rybbit tracking requests
- `(docs)/proxy-guide/get-started.mdx` — **Generic Proxy Setup** — Framework-agnostic guide to proxy Rybbit tracking through your own domain
- `(docs)/proxy-guide/index.mdx` — **Proxy Setup Guide** — Bypass ad blockers and improve tracking accuracy by proxying Rybbit through your own domain
- `(docs)/proxy-guide/laravel.mdx` — **Laravel Proxy Setup** — Configure Laravel routes and middleware to proxy Rybbit tracking
- `(docs)/proxy-guide/next-js.mdx` — **Next.js Proxy Setup** — Configure Next.js rewrites to proxy Rybbit tracking and bypass ad blockers
- `(docs)/proxy-guide/nginx.mdx` — **Nginx Proxy Setup** — Configure Nginx reverse proxy to serve Rybbit tracking and bypass ad blockers
- `(docs)/proxy-guide/troubleshooting.mdx` — **Troubleshooting Proxy Setup** — Common issues and solutions for Rybbit proxy configurations
- `(docs)/proxy-guide/vercel.mdx` — **Vercel Proxy Setup** — Deploy Rybbit proxy on Vercel with Edge Network caching

## guide/sdks

- `(docs)/sdks/node.mdx` — **JavaScript (Node.js)** — Server-side analytics tracking for Node.js applications
- `(docs)/sdks/react-native.mdx` — **React Native** — Official React Native SDK for Rybbit Analytics
- `(docs)/sdks/web.mdx` — **JavaScript (Web)** — Official JavaScript SDK for Rybbit Analytics

## guide/self-hosting-guides

- `(docs)/self-hosting-guides/custom-nginx.mdx` — **Custom Nginx setup** — Set up Rybbit with your own Nginx installation instead of using the built-in Caddy server
- `(docs)/self-hosting-guides/nginx-proxy-manager.mdx` — **Nginx Proxy Manager (NPM) setup** — Set up Rybbit with Nginx Proxy Manager without exposing ports directly to the host
- `(docs)/self-hosting-guides/pangolin.mdx` — **Pangolin setup** — Set up Rybbit with Pangolin as a self-hosted reverse proxy using Newt
- `(docs)/self-hosting-guides/self-hosting-advanced.mdx` — **Advanced self-hosting** — Advanced configuration options for self-hosting Rybbit
- `(docs)/self-hosting-guides/self-hosting-manual.mdx` — **Manual Docker Compose setup** — Manual setup guide for Rybbit using Docker Compose without the setup script
