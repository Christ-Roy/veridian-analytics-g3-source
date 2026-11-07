"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, FlaskConical, Send, XCircle } from "lucide-react";
import { useExtracted } from "next-intl";
import type { ReactNode } from "react";
import type { AdsHealth } from "@/api/google-ads";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { dureeCourte, envoiArrete, relatif } from "../temps";

type TonTuile = "neutre" | "succes" | "attention" | "erreur";

const TONS: Record<TonTuile, string> = {
  neutre: "text-neutral-900 dark:text-neutral-100",
  succes: "text-emerald-600 dark:text-emerald-400",
  attention: "text-yellow-600 dark:text-yellow-400",
  erreur: "text-red-600 dark:text-red-400",
};

/**
 * Tuile de chiffre. Le `Stat` du tableau de bord (`MainSection/Overview.tsx`)
 * n'est pas exporté ; il est recopié ici plutôt qu'exporté là-bas, pour ne pas
 * toucher un composant que d'autres écrans partagent.
 */
function Tuile({
  libelle,
  valeur,
  ton = "neutre",
  icone,
  note,
}: {
  libelle: string;
  valeur: number;
  ton?: TonTuile;
  icone: ReactNode;
  note?: string;
}) {
  // Un compteur à zéro ne se peint jamais en couleur d'alerte : « 0 échec »
  // n'est pas un échec, et « 0 envoyée » n'est pas une réussite.
  const tonEffectif: TonTuile = valeur === 0 ? "neutre" : ton;

  return (
    <div className="rounded-lg border border-neutral-100 dark:border-neutral-850 bg-white dark:bg-neutral-900 p-3">
      <div className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
        {icone}
        {libelle}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${TONS[tonEffectif]}`}>{valeur.toLocaleString()}</div>
      {note ? <div className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">{note}</div> : null}
    </div>
  );
}

/**
 * Le mode d'essai écarte volontairement les vraies conversions. Quelqu'un qui
 * l'ignore cherchera pendant des heures une panne qui n'existe pas — d'où un
 * bandeau pleine largeur, jamais une pastille discrète.
 */
export function BandeauModeEssai({ actif }: { actif: boolean }) {
  const t = useExtracted();

  if (!actif) return null;

  return (
    <Alert variant="warning">
      <FlaskConical className="h-4 w-4" />
      <AlertTitle>{t("Test mode is on: no real conversion is being sent")}</AlertTitle>
      <AlertDescription>
        {t(
          "Conversions are recorded and then deliberately discarded instead of being uploaded to Google Ads. They are counted as discarded, not as failures. Turn test mode off in the settings when you are ready to send for real."
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Pastille d'état, à côté du titre. */
export function PastilleEtat({ sante }: { sante: AdsHealth }) {
  const t = useExtracted();

  if (!sante.configured) return <Badge variant="outline">{t("Not configured")}</Badge>;
  if (sante.testMode) return <Badge variant="warning">{t("Test mode")}</Badge>;
  if (!sante.enabled) return <Badge variant="secondary">{t("Sending paused")}</Badge>;
  if (sante.failed > 0) return <Badge variant="destructive">{t("Failures")}</Badge>;
  return <Badge variant="success">{t("Sending")}</Badge>;
}

/**
 * L'écran « non configuré ». Il est volontairement TRÈS différent d'un écran de
 * compteurs à zéro : les deux situations demandent des gestes opposés, et un
 * tableau de bord vert et vide qui ne dit pas laquelle des deux on regarde est
 * le pire des mensonges.
 */
export function AdsNonConfigure({ action }: { action?: ReactNode }) {
  const t = useExtracted();

  return (
    <Alert variant="info">
      <CircleDashed className="h-4 w-4" />
      <AlertTitle>{t("Google Ads is not connected to this site yet")}</AlertTitle>
      <AlertDescription>
        <p>
          {t(
            "Nothing is being sent, and nothing is being recorded either. Add your Google Ads customer ID in the settings, then map at least one event to a conversion action."
          )}
        </p>
        {action ? <div className="mt-3">{action}</div> : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * « Les conversions s'entassent et ne partent plus ».
 *
 * Exporté parce que les TROIS surfaces du module doivent le dire, et le dire
 * pareil : la page, la carte du tableau de bord et le gestionnaire de réglages.
 * C'est la seule panne du module qui ne lève AUCUNE erreur côté serveur — un
 * écran qui se tait pendant que les deux autres alertent laisse croire à un
 * désaccord entre eux, ou pire, rassure celui qui regarde le mauvais.
 *
 * Le test négatif compte autant que le positif : une file longue mais À JOUR
 * (`oldestOverdueBy` à `null`) ne doit rien afficher, sans quoi on renvoie le
 * client chercher une panne inexistante à chaque montée en charge.
 */
export function AlerteEnvoiArrete({ sante }: { sante: AdsHealth }) {
  const t = useExtracted();
  const retard = sante.oldestOverdueBy;

  if (!envoiArrete(retard)) return null;

  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t("Conversions are piling up and are not being sent")}</AlertTitle>
      <AlertDescription>
        {t(
          "An upload was due {retard} ago and still has not run. Retries alone never explain a delay this long: the sender itself has stopped. Nothing raises an error in this state, so this is the only sign of it.",
          { retard: dureeCourte(retard) }
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Les avertissements de fond, dans l'ordre où ils comptent. Chacun décrit un
 * état qui ne lève AUCUNE erreur côté serveur : ils ne peuvent se voir qu'ici.
 */
function Avertissements({ sante }: { sante: AdsHealth }) {
  const t = useExtracted();

  // « Rien enregistré » ≠ « rien envoyé » : on ne le dit que si la file est
  // vraiment vierge sur tous les compteurs.
  const aucuneConversion = sante.pending === 0 && sante.sent === 0 && sante.failed === 0 && sante.skipped === 0;

  return (
    <>
      <AlerteEnvoiArrete sante={sante} />

      {sante.mappings === 0 ? (
        <Alert variant="warning">
          <CircleSlash className="h-4 w-4" />
          <AlertTitle>{t("No event is mapped to a conversion action")}</AlertTitle>
          <AlertDescription>
            {t(
              "The account is connected, so nothing looks broken, but with no mapping not a single conversion will ever be sent. Add one below."
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {!sante.enabled ? (
        <Alert variant="warning">
          <CircleSlash className="h-4 w-4" />
          <AlertTitle>{t("Sending is turned off")}</AlertTitle>
          <AlertDescription>
            {t("Conversions keep being recorded, but none leaves for Google Ads until you turn sending back on.")}
          </AlertDescription>
        </Alert>
      ) : null}

      {sante.mappings > 0 && aucuneConversion ? (
        <Alert variant="info">
          <CircleDashed className="h-4 w-4" />
          <AlertTitle>{t("No conversion recorded yet")}</AlertTitle>
          <AlertDescription>
            {t(
              "Everything is set up and waiting. This screen will fill in as soon as a visitor triggers one of the mapped events. Check that the event name matches the one your site actually fires."
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {sante.zeroValueSent > 0 ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {t("{count} conversions were sent without any amount", { count: String(sante.zeroValueSent) })}
          </AlertTitle>
          <AlertDescription>
            {t(
              "Google accepts and counts them, so no error is ever raised, but the return on ad spend it reports is wrong by exactly that much. Give the matching mapping a default value, or send the amount with the event."
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {sante.lastError ? (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>
            {t("Last error, {quand}", { quand: relatif(sante.lastError.at) ?? sante.lastError.at })}
          </AlertTitle>
          <AlertDescription>
            <code className="break-words text-xs">{sante.lastError.message}</code>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/**
 * L'état de santé complet : « est-ce que mes conversions arrivent chez Google,
 * oui ou non ». C'est le composant que la page met en TÊTE, avant les
 * correspondances et avant tout le reste.
 *
 * Volontairement sans appel de données : il reçoit `sante` et rien d'autre, ce
 * qui le rend testable au rendu sans fournisseur react-query (le dépôt n'en a
 * pas pour les tests).
 */
export function EtatSante({ sante, action }: { sante: AdsHealth; action?: ReactNode }) {
  const t = useExtracted();

  if (!sante.configured) {
    return <AdsNonConfigure action={action} />;
  }

  const attenteDepuis = relatif(sante.oldestPendingAt);
  const dernierEnvoi = relatif(sante.lastSentAt);

  return (
    <div className="space-y-3">
      <BandeauModeEssai actif={sante.testMode} />
      <Avertissements sante={sante} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tuile
          libelle={t("Pending")}
          valeur={sante.pending}
          ton="attention"
          icone={<CircleDashed className="h-3.5 w-3.5" />}
          note={sante.pending > 0 && attenteDepuis ? t("oldest {depuis}", { depuis: attenteDepuis }) : undefined}
        />
        <Tuile
          libelle={t("Sent")}
          valeur={sante.sent}
          ton="succes"
          icone={<Send className="h-3.5 w-3.5" />}
          note={dernierEnvoi ? t("last {quand}", { quand: dernierEnvoi }) : undefined}
        />
        <Tuile
          libelle={t("Failed")}
          valeur={sante.failed}
          ton="erreur"
          icone={<XCircle className="h-3.5 w-3.5" />}
        />
        <Tuile
          libelle={t("Discarded")}
          valeur={sante.skipped}
          ton="neutre"
          icone={<CircleSlash className="h-3.5 w-3.5" />}
          note={t("consent, 90-day window, test mode")}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
        {sante.customerId ? (
          <span>
            {t("Google Ads account")} <span className="font-mono">{sante.customerId}</span>
          </span>
        ) : null}
        <span>{t("{count} mapped events", { count: String(sante.mappings) })}</span>
        {sante.zeroValueSent > 0 ? (
          <span className="text-yellow-600 dark:text-yellow-400">
            {t("{count} sent with no amount", { count: String(sante.zeroValueSent) })}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" />
            {t("every sent conversion carried an amount")}
          </span>
        )}
        {/* Le sélecteur de période en haut de page pilote les autres écrans ;
            ces compteurs, eux, portent sur toute la file. Le dire évite de lire
            une baisse là où il n'y a qu'un changement de dates. */}
        <span>{t("counters cover the whole queue, not a date range")}</span>
      </div>
    </div>
  );
}
