import { userIdService, type UserIdOptions } from "./userIdService.js";

export interface VisitorIdentity {
  /** The browser's durable id (the tracker's `visitorId`), when the script sent one. */
  anonymousId?: string | null;
  ipAddress: string;
  userAgent: string;
}

/**
 * The ONE place that turns "who is this visitor" into the stored `user_id`.
 *
 * Every ingestion path that writes a `user_id` (page views and events, session
 * replay) goes through here. Two paths computing it on their own is how replays
 * ended up under a different user_id, hence a different session, than the very
 * visits they recorded: `has_replay` stayed 0 on every session of every site.
 *
 * The browser's `anonymous_id` wins; without it (old cached script, server-side
 * ingestion) the identity falls back to the IP + User-Agent fingerprint.
 * The hashes themselves are unchanged: changing them would rewrite the identity
 * of every visitor already measured.
 */
export async function resolveVisitorUserId(
  identity: VisitorIdentity,
  siteId: number,
  options: UserIdOptions = {}
): Promise<string> {
  const anonymousId = identity.anonymousId;
  if (anonymousId) {
    return userIdService.generateUserIdFromClientId(anonymousId, siteId, {
      saltUserIds: options.saltUserIds,
      receivedAt: options.receivedAt,
    });
  }
  return userIdService.generateUserId(identity.ipAddress, identity.userAgent, siteId, options);
}
