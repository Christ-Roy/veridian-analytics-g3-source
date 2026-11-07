import { Resend } from "resend";
import { render } from "@react-email/components";
import { IS_CLOUD } from "../const.js";
import { ApproachingLimitEmail } from "./templates/ApproachingLimitEmail.js";
import { InvitationEmail } from "./templates/InvitationEmail.js";
import { LimitExceededEmail } from "./templates/LimitExceededEmail.js";
import { OnboardingTipEmail } from "./templates/OnboardingTipEmail.js";
import { OtpEmail, type OtpEmailType } from "./templates/OtpEmail.js";
import { ReengagementEmail } from "./templates/ReengagementEmail.js";
import { WeeklyReportEmail } from "./templates/WeeklyReportEmail.js";
import type { SiteReport } from "../../services/weekyReports/weeklyReportTypes.js";
import type { OnboardingTipContent } from "../../services/onboardingTips/onboardingTipsContent.js";
import type { ReengagementContent } from "../../services/reengagement/reengagementContent.js";
import { BRAND } from "../../lib/brand.js";

let resend: Resend | undefined;
let marketingAudienceId: string | null = null;

if (IS_CLOUD) {
  resend = new Resend(process.env.RESEND_API_KEY);
}

type SentEmail = {
  id?: string;
  messageId?: string;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

/**
 * Why an email cannot be sent, or null when delivery is configured.
 *
 * This is the SINGLE source of truth for "can we send at all", read both by the
 * sender below and by the auth layer, which must refuse a request up front
 * rather than accept it and drop the mail.
 *
 * It exists because of a silent failure measured on 2026-09-02: neither
 * BREVO_API_KEY nor BREVO_SENDER_EMAIL had ever been set on this deployment,
 * and `POST /api/auth/email-otp/send-verification-otp` answered **200 with no
 * log line at all** — better-auth runs that callback through
 * `runInBackgroundOrAwait`, which swallows the exception. The magic link, whose
 * callback is awaited directly, answered 500. Same broken chain, two opposite
 * signals, and the reassuring one was the lie.
 */
export const emailDeliveryUnavailableReason = (): string | null => {
  if (IS_CLOUD) {
    return process.env.RESEND_API_KEY ? null : "RESEND_API_KEY is not set";
  }
  const missing = [
    process.env.BREVO_API_KEY ? null : "BREVO_API_KEY",
    process.env.BREVO_SENDER_EMAIL ? null : "BREVO_SENDER_EMAIL",
  ].filter(Boolean);
  return missing.length ? `${missing.join(" and ")} not set` : null;
};

export const isEmailDeliveryConfigured = (): boolean => emailDeliveryUnavailableReason() === null;

const sendBrevoEmail = async (email: string, subject: string, html: string): Promise<SentEmail> => {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;

  if (!apiKey || !senderEmail) {
    throw new Error("Email delivery is not configured");
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: {
        email: senderEmail,
        name: process.env.BREVO_SENDER_NAME || BRAND.name,
      },
      replyTo: {
        email: BRAND.supportEmail,
        name: BRAND.name,
      },
      to: [{ email }],
      subject,
      htmlContent: html,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Brevo email delivery failed (${response.status}): ${detail.slice(0, 500)}`);
  }

  return (await response.json()) as SentEmail;
};

// Marketing audience management
export const getOrCreateMarketingAudience = async (): Promise<string> => {
  if (marketingAudienceId) return marketingAudienceId;
  if (!resend) throw new Error("Resend not initialized");

  // List existing audiences to check if "Marketing" exists
  const { data: audiences } = await resend.audiences.list();
  const existing = audiences?.data?.find((a: { name: string }) => a.name === "Marketing");

  if (existing) {
    marketingAudienceId = existing.id;
    return existing.id;
  }

  // Create new audience
  const { data } = await resend.audiences.create({ name: "Marketing" });
  marketingAudienceId = data!.id;
  return data!.id;
};

export const addContactToAudience = async (email: string, firstName?: string): Promise<void> => {
  if (!resend) return;
  try {
    const audienceId = await getOrCreateMarketingAudience();
    await resend.contacts.create({ audienceId, email, firstName, unsubscribed: false });
  } catch (error) {
    console.error("Failed to add contact to audience:", error);
  }
};

export const isContactUnsubscribed = async (email: string): Promise<boolean> => {
  if (!resend) return false;
  try {
    const audienceId = await getOrCreateMarketingAudience();
    const { data: contact } = await resend.contacts.get({ audienceId, email });
    // If contact doesn't exist or is unsubscribed, return true to skip sending
    if (!contact) return true;
    return contact.unsubscribed ?? false;
  } catch (error) {
    // If contact doesn't exist (404), don't send email
    return true;
  }
};

export const unsubscribeContact = async (email: string): Promise<void> => {
  if (!resend) return;
  try {
    const audienceId = await getOrCreateMarketingAudience();
    await resend.contacts.update({ audienceId, email, unsubscribed: true });
  } catch (error) {
    console.error("Failed to unsubscribe contact:", error);
  }
};

export const sendEmail = async (email: string, subject: string, html: string) => {
  if (resend) {
    try {
      const response = await resend.emails.send({
        from: "Rybbit <automail@email.rybbit.com>",
        to: email,
        subject,
        html,
      });
      return response;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  return sendBrevoEmail(email, subject, html);
};

export const sendMagicLinkEmail = async (email: string, magicLinkUrl: string) => {
  const safeUrl = escapeHtml(magicLinkUrl);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111827;">
      <h2 style="margin: 0 0 16px;">Votre accès Veridian Analytics</h2>
      <p>Utilisez ce lien unique pour vous connecter au tableau de bord. Il expire dans 10 minutes et ne peut être utilisé qu’une fois.</p>
      <p style="margin: 24px 0;">
        <a href="${safeUrl}" style="background: #111827; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">Ouvrir mon tableau de bord</a>
      </p>
      <p style="font-size: 12px; color: #6b7280; word-break: break-all;">Si vous n’avez pas demandé ce lien, vous pouvez ignorer cet e-mail.</p>
    </div>
  `;

  await sendEmail(email, "Votre lien de connexion Veridian Analytics", html);
};

const OTP_SUBJECTS: Record<OtpEmailType, string> = {
  "sign-in": "Your Rybbit Sign-In Code",
  "email-verification": "Verify Your Email Address",
  "forget-password": "Reset Your Password",
  "change-email": "Change Your Email Address",
};

export const sendOtpEmail = async (email: string, otp: string, type: OtpEmailType) => {
  const html = await render(OtpEmail({ otp, type }));
  await sendEmail(email, OTP_SUBJECTS[type], html);
};

export const sendEmailVerificationLink = async (email: string, verificationUrl: string) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
      <h2 style="margin: 0 0 16px;">Verify your email</h2>
      <p>Click the button below to verify this email address on your Rybbit account.</p>
      <p style="margin: 24px 0;">
        <a href="${verificationUrl}" style="background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">Verify email</a>
      </p>
      <p style="font-size: 12px; color: #666; word-break: break-all;">Or paste this link into your browser: ${verificationUrl}</p>
    </div>
  `;

  await sendEmail(email, "Verify your Rybbit email", html);
};

export const sendChangeEmailVerification = async (
  currentEmail: string,
  newEmail: string,
  verificationUrl: string
) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
      <h2 style="margin: 0 0 16px;">Confirm your new email</h2>
      <p>We received a request to change the email on your Rybbit account from <strong>${currentEmail}</strong> to <strong>${newEmail}</strong>.</p>
      <p>Click the button below to confirm the change. If you didn't request this, you can safely ignore this email.</p>
      <p style="margin: 24px 0;">
        <a href="${verificationUrl}" style="background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">Confirm email change</a>
      </p>
      <p style="font-size: 12px; color: #666; word-break: break-all;">Or paste this link into your browser: ${verificationUrl}</p>
    </div>
  `;

  await sendEmail(currentEmail, "Confirm your email change on Rybbit", html);
};

export const sendInvitationEmail = async (
  email: string,
  invitedBy: string,
  organizationName: string,
  inviteLink: string
) => {
  const html = await render(
    InvitationEmail({
      email,
      invitedBy,
      organizationName,
      inviteLink,
    })
  );

  await sendEmail(email, "You're Invited to Join an Organization on Rybbit", html);
};

export const sendLimitExceededEmail = async (
  email: string,
  organizationName: string,
  eventCount: number,
  eventLimit: number
) => {
  const upgradeLink = `${BRAND.appUrl}/settings/subscription`;

  const html = await render(
    LimitExceededEmail({
      organizationName,
      eventCount,
      eventLimit,
      upgradeLink,
    })
  );

  await sendEmail(email, `Action Required: ${organizationName} has exceeded its monthly event limit`, html);
};

export const sendApproachingLimitEmail = async (
  email: string,
  organizationName: string,
  eventCount: number,
  eventLimit: number
) => {
  const upgradeLink = `${BRAND.appUrl}/settings/subscription`;

  const html = await render(
    ApproachingLimitEmail({
      organizationName,
      eventCount,
      eventLimit,
      upgradeLink,
    })
  );

  await sendEmail(email, `${organizationName} is approaching its monthly event limit`, html);
};

export const sendWeeklyReportEmail = async (
  email: string,
  userName: string,
  organizationName: string,
  site: SiteReport
) => {
  const html = await render(
    WeeklyReportEmail({
      userName,
      organizationName,
      site,
    })
  );

  const subject = `Weekly Analytics Report - ${site.siteName}`;

  await sendEmail(email, subject, html);
};

export const sendWelcomeEmail = async (email: string, name?: string) => {
  if (!resend) return;

  const greeting = name ? `Hi ${name}` : "Hi there";
  const text = `${greeting},

Welcome to Rybbit! Thanks for signing up.

I'm excited to have you on board. Rybbit is fully self-funded and we're fully committed to making an analytics platform that only serves the interests of our users.

If you run into any issues or have any questions or suggestions, just reply to this email - I'd love to hear from you.

Cheers,
Bill`;

  try {
    await resend.emails.send({
      from: "Bill from Rybbit <bill@email.rybbit.com>",
      replyTo: "hello@rybbit.com",
      to: email,
      subject: "Welcome to Rybbit!",
      text,
    });
  } catch (error) {
    console.error("Failed to send welcome email:", error);
  }
};

// Scheduled onboarding tip email - returns the email ID for cancellation
export const scheduleOnboardingTipEmail = async (
  email: string,
  userName: string,
  tipContent: OnboardingTipContent,
  scheduledAt: string
): Promise<string | null> => {
  if (!resend) return null;

  const unsubscribeUrl = `${process.env.BASE_URL}/api/user/unsubscribe-marketing-oneclick?email=${encodeURIComponent(email)}`;

  try {
    const html = await render(
      OnboardingTipEmail({
        userName,
        body: tipContent.body,
        linkText: tipContent.linkText,
        linkUrl: tipContent.linkUrl,
        unsubscribeUrl,
      })
    );

    const response = await resend.emails.send({
      from: "Rybbit <automail@email.rybbit.com>",
      to: email,
      subject: tipContent.subject,
      html,
      scheduledAt,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    return response.data?.id ?? null;
  } catch (error) {
    console.error("Failed to schedule onboarding tip email:", error);
    return null;
  }
};

// Cancel a scheduled email
export const cancelScheduledEmail = async (emailId: string): Promise<void> => {
  if (!resend) return;
  try {
    await resend.emails.cancel(emailId);
  } catch (error) {
    console.error("Failed to cancel scheduled email:", error);
  }
};

// Send re-engagement email
export const sendReengagementEmail = async (
  email: string,
  userName: string,
  content: ReengagementContent,
  siteId: number,
  domain: string
): Promise<void> => {
  if (!resend) return;

  const unsubscribeUrl = `${process.env.BASE_URL}/api/user/unsubscribe-marketing-oneclick?email=${encodeURIComponent(email)}`;

  try {
    const html = await render(
      ReengagementEmail({
        userName,
        day: content.day,
        title: content.title,
        message: content.message,
        ctaText: content.ctaText,
        siteId,
        domain,
        unsubscribeUrl,
      })
    );

    await resend.emails.send({
      from: "Rybbit <automail@email.rybbit.com>",
      to: email,
      subject: content.subject,
      html,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  } catch (error) {
    console.error("Failed to send re-engagement email:", error);
  }
};
