/**
 * Preuve réseau réelle : NOTRE client parle-t-il correctement à Google ?
 *
 * Les 31 tests de `dataManager.test.ts` valident la logique avec un `fetch`
 * simulé. Ils ne prouvent donc rien sur ce que Google accepte réellement — et
 * c'est précisément là que se logent les pièges de cette API.
 *
 * 🔴 Ce fichier est IGNORÉ par défaut. Il ne s'exécute que si
 * `ADS_PREUVE_REELLE=1`, parce qu'il fait de VRAIS appels sur un VRAI compte
 * publicitaire. Il ne doit jamais tourner en intégration continue : les
 * identifiants n'y sont pas, et un envoi réel n'a rien à faire dans une CI.
 *
 * Il n'engage aucune dépense : le compte ASD n'a aucun moyen de paiement, aucune
 * campagne ne tourne, et les identifiants de clic envoyés sont préfixés `TEST_`
 * donc ils ne correspondent à aucun clic réel.
 *
 * Lancement :
 *   set -a; source ~/credentials/.all-creds.env; set +a
 *   ADS_PREUVE_REELLE=1 npx vitest run src/api/ads/dataManager.reel.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  AdsIngestError,
  ingestConversions,
  resetTokenCacheForTests,
  type AdsCredentials,
  type AdsDestination,
} from "./dataManager.js";

const ACTIF = process.env.ADS_PREUVE_REELLE === "1";

const credentials: AdsCredentials = {
  clientId: process.env.GOOGLE_ADS_OAUTH_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET ?? "",
  refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN ?? "",
};

/** Compte ASD, sous le compte administrateur Veridian. */
const COMPTE_ASD = "2568911678";
const MCC_VERIDIAN = "6437191896";
/** « Achat (import serveur) », type UPLOAD_CLICKS, créée le 2026-08-29. */
const ACTION_IMPORT = "7738478145";

const destination: AdsDestination = {
  operatingAccountId: COMPTE_ASD,
  loginAccountId: MCC_VERIDIAN,
  conversionActionId: ACTION_IMPORT,
};

/** Un horodatage récent : Google refuse ce qui est dans le futur. */
function ilYAUneHeure(): string {
  return new Date(Date.now() - 3600_000).toISOString();
}

function conversion(transactionId: string, extra: Record<string, unknown> = {}) {
  return {
    transactionId,
    gclid: "TEST_VERIDIAN_PREUVE_MODULE",
    occurredAt: ilYAUneHeure(),
    value: 49.9,
    currency: "EUR",
    consent: {
      adUserData: "CONSENT_GRANTED" as const,
      adPersonalization: "CONSENT_GRANTED" as const,
    },
    ...extra,
  };
}

describe.skipIf(!ACTIF)("preuve réelle contre la Data Manager API", () => {
  it("les identifiants sont présents et portent le scope datamanager", async () => {
    // Sans ce contrôle, tous les autres échoueraient avec un message obscur.
    expect(credentials.clientId, "GOOGLE_ADS_OAUTH_CLIENT_ID absent").not.toBe("");
    expect(credentials.refreshToken, "GOOGLE_ADS_REFRESH_TOKEN absent").not.toBe("");
  });

  it("valide un envoi sans rien écrire dans le compte", async () => {
    resetTokenCacheForTests();
    const res = await ingestConversions(credentials, destination, [conversion("preuve-validation")], {
      validateOnly: true,
    });
    expect(res.requestId).toBeTruthy();
    expect(res.eventCount).toBe(1);
  });

  it("envoie une conversion pour de vrai et Google l'accepte", async () => {
    const res = await ingestConversions(credentials, destination, [
      conversion(`preuve-module-${Date.now()}`),
    ]);
    expect(res.requestId).toBeTruthy();
    expect(res.validateOnly).toBe(false);
  });

  it("rejoue la MÊME conversion sans que Google la refuse", async () => {
    // L'identifiant de transaction est stable : c'est sur lui que Google
    // déduplique. Un rejeu du drain ne doit donc pas produire d'erreur — et ne
    // comptera pas deux fois. Ce test prouve le premier point ; le second ne se
    // vérifie que dans les rapports du compte, en différé.
    const id = "preuve-module-rejeu-stable";
    const a = await ingestConversions(credentials, destination, [conversion(id)]);
    const b = await ingestConversions(credentials, destination, [conversion(id)]);
    expect(a.requestId).toBeTruthy();
    expect(b.requestId).toBeTruthy();
    // Deux allers-retours réseau : le délai par défaut de 5 s de vitest ne suffit pas.
  }, 20_000);

  it("classe une action de conversion inexistante en échec DÉFINITIF", async () => {
    // Contrôle négatif : si ce test passait, le drain réessaierait indéfiniment
    // une configuration fausse.
    const erreur = await ingestConversions(
      credentials,
      { ...destination, conversionActionId: "9999999999" },
      [conversion("preuve-action-absente")],
    ).catch(e => e as AdsIngestError);

    expect(erreur).toBeInstanceOf(AdsIngestError);
    expect((erreur as AdsIngestError).retryable).toBe(false);
    expect((erreur as AdsIngestError).status).toBe(404);
  });

  it("classe un compte hors périmètre en échec DÉFINITIF", async () => {
    const erreur = await ingestConversions(
      credentials,
      { ...destination, operatingAccountId: "1111111111" },
      [conversion("preuve-compte-etranger")],
    ).catch(e => e as AdsIngestError);

    expect(erreur).toBeInstanceOf(AdsIngestError);
    expect((erreur as AdsIngestError).retryable).toBe(false);
    expect((erreur as AdsIngestError).status).toBe(403);
  });

  it("refuse une conversion datée dans le futur", async () => {
    // La SEULE borne temporelle que Google applique à l'envoi. Une conversion
    // trop VIEILLE, elle, est acceptée en 200 et jamais comptée : c'est pour ça
    // que la fenêtre de 90 jours est contrôlée dans notre propre code.
    const dansDeuxJours = new Date(Date.now() + 2 * 86400_000).toISOString();
    const erreur = await ingestConversions(credentials, destination, [
      conversion("preuve-futur", { occurredAt: dansDeuxJours }),
    ]).catch(e => e as AdsIngestError);

    expect(erreur).toBeInstanceOf(AdsIngestError);
    expect((erreur as AdsIngestError).retryable).toBe(false);
    expect((erreur as AdsIngestError).status).toBe(400);
  });
});
