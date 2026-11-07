/**
 * Ce qu'un utilisateur possède dans cette application, vu du Hub.
 *
 * Source unique pour la découverte (`getUserByEmail`) et le rebond
 * (`issueMagicLink`) : si les deux divergeaient, le Hub afficherait une carte
 * qui mène à un refus, ou connecterait quelqu'un sans rien à voir.
 *
 * Un « workspace » au sens du Hub est ici un SITE. Le Hub affiche une carte par
 * workspace, donc renvoyer l'organisation ferait disparaître les sites derrière
 * un seul lien, alors que c'est le site qu'un client vient consulter.
 *
 * Ce que voit l'utilisateur suit exactement la règle d'accès de l'application
 * (`lib/access.ts`) : propriétaire et administrateur voient tous les sites de
 * leur organisation, un membre seulement ceux qui lui sont accordés — par grant
 * explicite ou par équipe. Un endpoint de découverte qui montrerait plus que
 * l'application elle-même serait une fuite.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/postgres/postgres.js";
import { member, organization, sites, user } from "../../db/postgres/schema.js";
import { isOrgAdmin, memberCanAccessSite, resolveMemberSiteGrants } from "../../lib/access.js";
import { BRAND } from "../../lib/brand.js";

/**
 * Validation d'adresse volontairement permissive : elle sert à écarter une
 * entrée absurde, pas à arbitrer la conformité RFC. La longueur maximale est
 * celle d'une adresse (RFC 5321).
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

export function isValidEmail(email: string): boolean {
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_RE.test(email);
}

/** Carte d'application telle que le Hub l'attend (`lib/sync/types.ts`). */
export interface WorkspaceCard {
  workspace_id: string;
  workspace_name: string;
  role: string;
  plan: string;
  status: "active" | "suspended" | "deleted";
  magic_link_capable: boolean;
  fallback_url: string;
}

export interface AccountWorkspaces {
  account: { id: string; email: string; banned: boolean | null; hubUserId: string | null };
  workspaces: WorkspaceCard[];
}

/**
 * Le plan d'une organisation sans appeler Stripe. La découverte tient dans un
 * budget de 2 s côté Hub et s'exécute à chaque connexion : un aller-retour
 * réseau par organisation la ferait expirer, et le Hub afficherait l'app comme
 * indisponible. Les surcharges locales suffisent — c'est ce que porte notre
 * instance auto-hébergée.
 */
function resolvePlan(org: { planOverride: string | null; customPlan: unknown }): string {
  if (org.planOverride) {
    return org.planOverride;
  }
  return org.customPlan ? "custom" : "free";
}

/**
 * @param email Adresse déjà normalisée (sans espaces, en minuscules).
 * @returns `null` si l'utilisateur est inconnu ou n'a accès à aucun site.
 */
export async function findAccountWorkspaces(email: string): Promise<AccountWorkspaces | null> {
  // Comparaison insensible à la casse : le Hub transmet l'adresse telle que
  // saisie à la connexion, qui n'a aucune raison de correspondre octet pour
  // octet à celle enregistrée ici.
  const [account] = await db
    .select({ id: user.id, email: user.email, banned: user.banned, hubUserId: user.hubUserId })
    .from(user)
    .where(sql`lower(${user.email}) = ${email}`)
    .limit(1);

  if (!account) {
    return null;
  }

  const memberships = await db
    .select({
      id: member.id,
      userId: member.userId,
      organizationId: member.organizationId,
      role: member.role,
      hasRestrictedSiteAccess: member.hasRestrictedSiteAccess,
    })
    .from(member)
    .where(eq(member.userId, account.id));

  if (memberships.length === 0) {
    return null;
  }

  const organizationIds = Array.from(new Set(memberships.map(m => m.organizationId)));
  const membershipByOrgId = new Map(memberships.map(m => [m.organizationId, m]));

  // Les organisations où l'utilisateur n'est que membre sont les seules à
  // devoir passer par la résolution des grants ; ailleurs il voit tout.
  const memberRoleMemberships = memberships.filter(m => !isOrgAdmin(m));

  const [orgRows, siteRows, grants] = await Promise.all([
    db
      .select({
        id: organization.id,
        planOverride: organization.planOverride,
        customPlan: organization.customPlan,
      })
      .from(organization)
      .where(inArray(organization.id, organizationIds)),
    db
      .select({
        siteId: sites.siteId,
        name: sites.name,
        domain: sites.domain,
        organizationId: sites.organizationId,
      })
      .from(sites)
      .where(inArray(sites.organizationId, organizationIds)),
    memberRoleMemberships.length > 0
      ? resolveMemberSiteGrants({
          userId: account.id,
          organizationIds: memberRoleMemberships.map(m => m.organizationId),
          grantedMemberIds: memberRoleMemberships.filter(m => m.hasRestrictedSiteAccess).map(m => m.id),
        })
      : Promise.resolve(null),
  ]);

  const orgById = new Map(orgRows.map(org => [org.id, org]));

  const workspaces: WorkspaceCard[] = [];
  for (const site of siteRows) {
    if (!site.organizationId) {
      continue;
    }
    const membership = membershipByOrgId.get(site.organizationId);
    if (!membership) {
      continue;
    }
    // Administrateur et propriétaire échappent au filtrage par site.
    if (!isOrgAdmin(membership)) {
      if (!grants || !memberCanAccessSite(grants, site.siteId, membership.hasRestrictedSiteAccess)) {
        continue;
      }
    }

    const org = orgById.get(site.organizationId);
    workspaces.push({
      workspace_id: String(site.siteId),
      workspace_name: site.name || site.domain,
      role: membership.role,
      plan: org ? resolvePlan(org) : "free",
      // Rybbit ne connaît pas la suspension d'un site : un site existe ou
      // n'existe pas. Le jour où le Hub pilotera la suspension, elle se
      // reflétera ici.
      status: "active",
      // `POST /api/sso/issue-magic-link` existe : le Hub peut connecter le
      // client sans lui redemander de mot de passe.
      magic_link_capable: true,
      fallback_url: `${BRAND.appUrl}/${site.siteId}`,
    });
  }

  if (workspaces.length === 0) {
    return null;
  }

  return { account, workspaces };
}
