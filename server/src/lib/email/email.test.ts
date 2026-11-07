import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("self-hosted transactional email", () => {
  it("sends a magic link through Brevo with the verified sender", async () => {
    vi.stubEnv("CLOUD", "false");
    vi.stubEnv("BREVO_API_KEY", "test-key");
    vi.stubEnv("BREVO_SENDER_EMAIL", "notifications@veridian.site");
    vi.stubEnv("BREVO_SENDER_NAME", "Veridian Analytics");

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messageId: "message-id" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { sendMagicLinkEmail } = await import("./email.js");
    await sendMagicLinkEmail("alice@example.com", "https://analytics.example/api/auth/magic-link/verify?token=a&next=/");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(request.body as string)).toMatchObject({
      sender: { email: "notifications@veridian.site", name: "Veridian Analytics" },
      to: [{ email: "alice@example.com" }],
      subject: "Votre lien de connexion Veridian Analytics",
    });
  });

  // ── L'AVEUGLEMENT, ET SA PREUVE ──────────────────────────────────────────
  // Ces trois cas figent la raison d'être de `emailDeliveryUnavailableReason` :
  // il est lu par le hook `before` de better-auth pour REFUSER une demande de
  // code de connexion quand rien ne peut partir. Mesuré le 2026-09-02 : sans
  // ce refus, `/api/auth/email-otp/send-verification-otp` rendait 200 sans une
  // seule ligne de journal, sur un déploiement où l'envoi n'a JAMAIS été
  // configuré. Le magic link, lui, rendait 500. Même panne, deux signaux
  // opposés, et le rassurant était le mensonge.
  //
  // Si quelqu'un « simplifie » ce helper en le faisant rendre null par défaut,
  // c'est ce test qui doit rougir — pas la production, six mois plus tard.
  it("names what is missing when self-hosted delivery is unconfigured", async () => {
    vi.stubEnv("CLOUD", "false");
    vi.stubEnv("BREVO_API_KEY", "");
    vi.stubEnv("BREVO_SENDER_EMAIL", "");

    const { emailDeliveryUnavailableReason, isEmailDeliveryConfigured } = await import("./email.js");
    expect(emailDeliveryUnavailableReason()).toBe("BREVO_API_KEY and BREVO_SENDER_EMAIL not set");
    expect(isEmailDeliveryConfigured()).toBe(false);
  });

  it("still reports unavailable when only the sender is missing", async () => {
    vi.stubEnv("CLOUD", "false");
    vi.stubEnv("BREVO_API_KEY", "une-cle");
    vi.stubEnv("BREVO_SENDER_EMAIL", "");

    const { emailDeliveryUnavailableReason } = await import("./email.js");
    expect(emailDeliveryUnavailableReason()).toBe("BREVO_SENDER_EMAIL not set");
  });

  it("reports available once both are set", async () => {
    vi.stubEnv("CLOUD", "false");
    vi.stubEnv("BREVO_API_KEY", "une-cle");
    vi.stubEnv("BREVO_SENDER_EMAIL", "notifications@veridian.site");

    const { emailDeliveryUnavailableReason, isEmailDeliveryConfigured } = await import("./email.js");
    expect(emailDeliveryUnavailableReason()).toBeNull();
    expect(isEmailDeliveryConfigured()).toBe(true);
  });

  it("fails closed when the self-hosted email provider is not configured", async () => {
    vi.stubEnv("CLOUD", "false");
    vi.stubEnv("BREVO_API_KEY", "");
    vi.stubEnv("BREVO_SENDER_EMAIL", "");

    const { sendEmail } = await import("./email.js");
    await expect(sendEmail("alice@example.com", "Subject", "<p>Content</p>")).rejects.toThrow(
      "Email delivery is not configured"
    );
  });
});
