"use client";

import {
  useCreateAdsMapping,
  useDeleteAdsMapping,
  useGetAdsHealth,
  useGetAdsMappings,
  useGetAdsSettings,
  useUpdateAdsSettings,
} from "@/api/google-ads/hooks";
import { validerCompteAds } from "@/api/google-ads/validation";
// Les trois écrans du module (page, carte, réglages) partagent leurs règles
// d'affichage plutôt que d'en recopier chacun sa version : un mot différent
// pour le même compteur se lit comme deux chiffres différents.
import { AlerteEnvoiArrete } from "@/app/[site]/google-ads/components/EtatSante";
import { formaterMontant } from "@/app/[site]/google-ads/montant";
import { relatif } from "@/app/[site]/google-ads/temps";
import { ConfirmationModal } from "@/components/ConfirmationModal";
import { ErrorState } from "@/components/ErrorState";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, FlaskConical, Trash2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { SettingRow } from "./SettingsSection";

interface GoogleAdsManagerProps {
  /**
   * L'utilisateur administre-t-il CE site (`siteMetadata.isOwner`) ?
   *
   * 🔴 Sans valeur par défaut, et volontairement : une permission qui se
   * défausse sur `false` verrouille tout le monde en silence, une qui se
   * défausse sur `true` ouvre le robinet à tout le monde. Les deux se lisent
   * comme un fonctionnement normal. En l'exigeant, un nouvel appelant qui
   * l'oublie ne compile pas.
   *
   * Le motif est celui de `SearchConsole.tsx` (« demandez à un administrateur
   * du site »), mais la SOURCE est différente : là-bas c'est `useCurrentSite()`,
   * qui déduit le site du chemin de l'URL. Le dialogue de réglages s'ouvre
   * aussi depuis la page d'accueil, où le chemin ne porte aucun site : ce hook
   * y rendrait `undefined`, donc `isOwner` faux, donc un administrateur
   * légitime en lecture seule sans le moindre message d'erreur.
   */
  canManage: boolean;
  disabled?: boolean;
}

/**
 * Réglages de l'envoi des conversions vers Google Ads.
 *
 * Trois choix d'écran ne sont pas cosmétiques :
 *
 * 1. **L'activation passe par un bouton et une confirmation, pas par un
 *    interrupteur qu'on bascule.** Activer engage de l'argent publicitaire sur
 *    le compte d'un CLIENT : les conversions remontées pilotent ses enchères.
 *    Un contrôle qu'on effleure ne peut pas décider ça.
 * 2. **Le mode d'essai s'affiche en bandeau permanent quand il est actif**, pas
 *    replié. Sinon la question « pourquoi je ne vois aucune conversion » se
 *    pose pendant des jours alors que la réponse tient en un mot.
 * 3. **Le format à tirets est annoncé avant la saisie**, parce que c'est ce que
 *    l'interface Google affiche et donc ce que les gens collent.
 * 4. **Un non-administrateur voit l'ÉTAT mais aucun contrôle d'écriture.** Le
 *    serveur exige déjà l'administration du site en écriture ; afficher les
 *    contrôles quand même reviendrait à promettre une action qui finit en 403.
 *    Masquer l'état en revanche créerait l'autre problème : le client qui ne
 *    comprend pas pourquoi ses conversions n'arrivent pas.
 */
export function GoogleAdsManager({ canManage, disabled = false }: GoogleAdsManagerProps) {
  const t = useExtracted();

  const { data: reglages, isLoading, error, refetch } = useGetAdsSettings();
  const { data: correspondances } = useGetAdsMappings();
  const { data: sante } = useGetAdsHealth();
  const { mutateAsync: enregistrer, isPending: enregistrementEnCours } = useUpdateAdsSettings();
  const { mutateAsync: creerCorrespondance, isPending: creationEnCours } = useCreateAdsMapping();
  const { mutateAsync: supprimerCorrespondance } = useDeleteAdsMapping();

  const settings = reglages?.settings ?? null;
  const configure = Boolean(reglages?.configured);

  const [compte, setCompte] = useState<string | null>(null);
  const [erreurCompte, setErreurCompte] = useState<string | null>(null);
  const [modaleActivation, setModaleActivation] = useState(false);
  const [modaleSortieEssai, setModaleSortieEssai] = useState(false);

  // Champ non touché = valeur du serveur. On ne recopie pas la réponse dans un
  // état au premier rendu : ça fige la valeur et un rafraîchissement ne la
  // remonte plus.
  const valeurCompte = compte ?? settings?.customerId ?? "";

  const [evenement, setEvenement] = useState("");
  const [actionConversion, setActionConversion] = useState("");
  const [valeurParDefaut, setValeurParDefaut] = useState("");
  const [devise, setDevise] = useState("EUR");

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t("Loading...")}</p>;
  }

  // 🔴 L'erreur de chargement AVANT tout le reste, et jamais l'inverse. Sans
  // cette branche, une requête en échec laisse `reglages` à `undefined`, donc
  // `configure` est faux : l'écran affiche « Not set », un formulaire vide et un
  // bouton d'activation inerte sur un compte parfaitement branché. Le réflexe de
  // l'administrateur est alors de RESAISIR l'identifiant, donc de toucher à ce
  // qui marchait. C'est une panne déguisée en état normal — le même défaut que
  // la carte du tableau de bord traite, et pour la même raison.
  if (error) {
    return (
      <ErrorState
        title={t("Could not read the Google Ads settings")}
        message={error instanceof Error ? error.message : t("An error occurred while fetching the settings")}
        refetch={refetch}
      />
    );
  }

  const messageCompteInvalide = (resultat: ReturnType<typeof validerCompteAds>): string | null => {
    if (resultat.ok) return null;
    switch (resultat.motif) {
      case "vide":
        return t("A Google Ads account ID is required.");
      case "tirets":
        return `${t("Google Ads shows this ID with dashes, but it must be entered without them:")} ${resultat.sansTirets}`;
      case "non_numerique":
        return t("A Google Ads account ID is digits only, with no dashes or spaces.");
      case "longueur":
        return t("That does not look like a Google Ads account ID: a real one has 10 digits.");
    }
  };

  const enregistrerCompte = async () => {
    const resultat = validerCompteAds(valeurCompte);
    if (!resultat.ok) {
      setErreurCompte(messageCompteInvalide(resultat));
      return;
    }
    setErreurCompte(null);
    try {
      await enregistrer({ customerId: resultat.valeur });
      toast.success(t("Google Ads account saved"));
    } catch (error) {
      toast.error(String(error instanceof Error ? error.message : error));
    }
  };

  /** Bascule un drapeau des réglages. Le serveur conserve les champs absents. */
  const basculer = async (champ: "enabled" | "testMode", valeur: boolean, succes: string) => {
    // Clé explicite plutôt qu'un `{ [champ]: valeur }` : une clé calculée
    // s'écrit `{ [x: string]: boolean }` et perdrait le contrôle de type sur le
    // corps envoyé au serveur.
    const corps = champ === "enabled" ? { enabled: valeur } : { testMode: valeur };
    try {
      await enregistrer(corps);
      toast.success(succes);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      toast.error(message);
      // Relancé pour que ConfirmationModal garde la fenêtre ouverte et affiche
      // l'erreur, au lieu de se fermer sur un échec qui passerait inaperçu.
      throw error;
    }
  };

  const ajouterCorrespondance = async () => {
    try {
      await creerCorrespondance({
        eventName: evenement.trim(),
        conversionActionId: actionConversion.trim(),
        defaultValue: valeurParDefaut.trim() === "" ? null : valeurParDefaut.trim(),
        currency: devise.trim() || "EUR",
      });
      setEvenement("");
      setActionConversion("");
      setValeurParDefaut("");
      toast.success(t("Conversion mapping added"));
    } catch (error) {
      // Le message du serveur nomme l'action déjà associée en cas de doublon :
      // il est plus utile que n'importe quel texte générique.
      toast.error(String(error instanceof Error ? error.message : error));
    }
  };

  const enModeEssai = Boolean(settings?.testMode);
  const envoiActif = Boolean(settings?.enabled);

  return (
    <div className="space-y-5">
      {/* 🔴 Bandeau permanent : quelqu'un qui ne voit pas ses conversions doit
          comprendre en une seconde que le mode d'essai les écarte. */}
      {enModeEssai && (
        <Alert variant="warning">
          <FlaskConical className="h-4 w-4" />
          <AlertTitle>{t("Test mode is on")}</AlertTitle>
          <AlertDescription>
            {t(
              "Conversions are recorded but never sent to Google Ads. Your campaigns will not see them and bidding is unaffected."
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* La phrase qui dit à qui s'adresser, une seule fois et en tête : elle
          explique l'absence de TOUS les contrôles qui suivent. */}
      {!canManage && (
        <p className="text-sm text-muted-foreground">
          {t("Ask a site admin to change these Google Ads settings.")}
        </p>
      )}

      {/* Identifiant du compte */}
      <div className="space-y-2">
        <Label htmlFor="ads-customer-id" className="text-sm font-medium">
          {t("Google Ads account ID")}
        </Label>
        {canManage ? (
          <>
            {/* L'aide est là AVANT la saisie : la faute probable est le
                copier-coller depuis l'interface Google, qui affiche des tirets. */}
            <p className="text-xs text-muted-foreground">
              {t("Digits only, no dashes. Google Ads displays it as 123-456-7890 — enter 1234567890.")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="ads-customer-id"
                inputMode="numeric"
                placeholder="1234567890"
                className="max-w-xs"
                value={valeurCompte}
                disabled={disabled}
                onChange={event => {
                  setCompte(event.target.value);
                  setErreurCompte(null);
                }}
              />
              <Button onClick={enregistrerCompte} disabled={disabled || enregistrementEnCours}>
                {enregistrementEnCours ? t("Saving...") : t("Save")}
              </Button>
              {configure && <Badge variant="success">{t("Configured")}</Badge>}
            </div>
            {erreurCompte && (
              <p role="alert" className="text-xs text-red-500">
                {erreurCompte}
              </p>
            )}
          </>
        ) : (
          // L'état reste lisible : c'est de l'information utile, et la cacher
          // fabriquerait la question « pourquoi mes conversions n'arrivent pas ».
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium tabular-nums">{settings?.customerId ?? t("Not set")}</span>
            {configure && <Badge variant="success">{t("Configured")}</Badge>}
          </div>
        )}
      </div>

      {/* Envoi des conversions — le seul contrôle qui engage de l'argent */}
      <SettingRow
        label={t("Send conversions to Google Ads")}
        description={t(
          "When on, every mapped event is uploaded to the account above and feeds its bidding. This spends the advertiser's budget differently."
        )}
        badge={
          envoiActif ? <Badge variant="success">{t("On")}</Badge> : <Badge variant="secondary">{t("Off")}</Badge>
        }
      >
        {canManage && (
        <ConfirmationModal
          title={envoiActif ? t("Stop sending conversions?") : t("Start sending conversions?")}
          description={
            envoiActif
              ? t("Google Ads will stop receiving conversions from this site. Bidding will lose that signal.")
              : t(
                  "Conversions from this site will be uploaded to the Google Ads account above. They feed automated bidding, so this changes how the advertiser's budget is spent."
                )
          }
          isOpen={modaleActivation}
          setIsOpen={setModaleActivation}
          onConfirm={() =>
            basculer(
              "enabled",
              !envoiActif,
              envoiActif ? t("Conversion uploads stopped") : t("Conversion uploads started")
            )
          }
          primaryAction={{
            variant: envoiActif ? "destructive" : "default",
            // Libellé distinct de celui du déclencheur : les deux boutons
            // coexistent à l'écran une fois la fenêtre ouverte.
            children: envoiActif ? t("Yes, stop sending") : t("Yes, start sending"),
          }}
        >
          <Button variant={envoiActif ? "outline" : "default"} disabled={disabled || !configure}>
            {envoiActif ? t("Stop sending") : t("Start sending")}
          </Button>
        </ConfirmationModal>
        )}
      </SettingRow>

      {/* Mode d'essai */}
      <SettingRow
        label={t("Test mode")}
        htmlFor="ads-test-mode"
        description={t("Conversions are recorded and counted, but nothing reaches Google Ads.")}
        badge={
          !canManage && enModeEssai ? <Badge variant="warning">{t("On")}</Badge> : undefined
        }
      >
        {canManage && (
        <>
        <Switch
          id="ads-test-mode"
          checked={enModeEssai}
          disabled={disabled || !configure}
          onCheckedChange={async valeur => {
            // Entrer en mode d'essai ne coûte rien et s'annule. En SORTIR
            // pendant que l'envoi est actif ouvre le robinet : même risque que
            // l'activation, donc même confirmation.
            if (!valeur && envoiActif) {
              setModaleSortieEssai(true);
              return;
            }
            await basculer("testMode", valeur, valeur ? t("Test mode enabled") : t("Test mode disabled")).catch(
              () => undefined
            );
          }}
        />
        <ConfirmationModal
          title={t("Leave test mode?")}
          description={t(
            "Sending is already on. Leaving test mode means the next conversions really reach Google Ads and affect bidding."
          )}
          isOpen={modaleSortieEssai}
          setIsOpen={setModaleSortieEssai}
          onConfirm={() => basculer("testMode", false, t("Test mode disabled"))}
          primaryAction={{ variant: "warning", children: t("Leave test mode") }}
        >
          {/* ConfirmationModal monte son enfant dans un DialogTrigger `asChild`,
              qui exige un unique élément. Cette fenêtre est ouverte par
              l'interrupteur ci-dessus, pas par un déclencheur propre. */}
          <span className="hidden" aria-hidden />
        </ConfirmationModal>
        </>
        )}
      </SettingRow>

      {/* Correspondances événement → action de conversion */}
      <div className="space-y-3">
        <div>
          <h4 className="text-sm font-medium text-foreground">{t("Conversion mappings")}</h4>
          <p className="text-xs text-muted-foreground">
            {t(
              "Each mapping ties one tracked event to one Google Ads conversion action. Events with no mapping are never sent."
            )}
          </p>
        </div>

        {correspondances?.mappings?.length ? (
          <ul className="divide-y divide-neutral-150 dark:divide-neutral-850 rounded-md border border-neutral-150 dark:border-neutral-850">
            {correspondances.mappings.map(correspondance => (
              <li key={correspondance.id} className="flex items-center justify-between gap-4 px-3 py-2">
                <div className="min-w-0 text-sm">
                  <span className="font-medium">{correspondance.eventName}</span>
                  <span className="text-muted-foreground"> → {correspondance.conversionActionId}</span>
                  <p className="text-xs text-muted-foreground">
                    {correspondance.defaultValue
                      ? formaterMontant(correspondance.defaultValue, correspondance.currency)
                      : t("No default value — sent as a zero-value conversion unless the event carries one.")}
                  </p>
                </div>
                {canManage && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("Delete mapping")}
                  disabled={disabled}
                  onClick={async () => {
                    try {
                      await supprimerCorrespondance(correspondance.id);
                      toast.success(t("Conversion mapping deleted"));
                    } catch (error) {
                      toast.error(String(error instanceof Error ? error.message : error));
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t("No mapping yet. Nothing is sent to Google Ads.")}</p>
        )}

        {canManage && (
        <>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="ads-event-name" className="text-xs">
              {t("Event")}
            </Label>
            <Input
              id="ads-event-name"
              className="w-44"
              placeholder="order_paid"
              value={evenement}
              disabled={disabled}
              onChange={event => setEvenement(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ads-action-id" className="text-xs">
              {t("Conversion action ID")}
            </Label>
            <Input
              id="ads-action-id"
              className="w-44"
              placeholder="987654321"
              value={actionConversion}
              disabled={disabled}
              onChange={event => setActionConversion(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ads-default-value" className="text-xs">
              {t("Default value")}
            </Label>
            <Input
              id="ads-default-value"
              className="w-28"
              placeholder="0.00"
              value={valeurParDefaut}
              disabled={disabled}
              onChange={event => setValeurParDefaut(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ads-currency" className="text-xs">
              {t("Currency")}
            </Label>
            <Input
              id="ads-currency"
              className="w-20"
              placeholder="EUR"
              value={devise}
              disabled={disabled}
              onChange={event => setDevise(event.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            onClick={ajouterCorrespondance}
            disabled={disabled || creationEnCours || !evenement.trim() || !actionConversion.trim()}
          >
            {creationEnCours ? t("Adding...") : t("Add mapping")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            "The conversion action ID is the number in the action's URL in Google Ads (ctId parameter), not the AW-… tag label."
          )}
        </p>
        </>
        )}
      </div>

      {/* État de santé */}
      {sante && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-foreground">{t("Delivery health")}</h4>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            {/* « Pending » et « Discarded », comme la page et la carte : un
                troisième vocabulaire pour les mêmes compteurs fait croire à
                trois chiffres différents. */}
            <EtatChiffre label={t("Pending")} valeur={sante.pending} />
            <EtatChiffre label={t("Sent")} valeur={sante.sent} />
            <EtatChiffre label={t("Failed")} valeur={sante.failed} />
            <EtatChiffre label={t("Discarded")} valeur={sante.skipped} />
            <EtatChiffre label={t("Sent with no value")} valeur={sante.zeroValueSent} />
            <EtatChiffre label={t("Mappings")} valeur={sante.mappings} />
          </dl>

          {/* 🔴 L'alerte de retard, la même que la page et la carte. Une file
              qui stagne ne lève AUCUNE erreur : c'est la seule panne du module
              sans symptôme ailleurs, et cet écran-là se taisait dessus. */}
          <AlerteEnvoiArrete sante={sante} />

          {/* L'ancienneté de la plus vieille ligne est une INFORMATION, jamais
              un diagnostic : le report entre deux tentatives est exponentiel,
              donc douze heures d'attente peuvent être parfaitement saines.
              C'est l'échéance dépassée, au-dessus, qui accuse. */}
          {sante.pending > 0 && sante.oldestPendingAt && (
            <p className="text-xs text-muted-foreground">
              {t("Oldest conversion still pending {depuis}", {
                depuis: relatif(sante.oldestPendingAt) ?? sante.oldestPendingAt,
              })}
            </p>
          )}
          {sante.zeroValueSent > 0 && (
            <Alert variant="warning">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t("Some conversions were sent without a value")}</AlertTitle>
              <AlertDescription>
                {t(
                  "Google accepts and counts them, so no error is raised, but the account's ROAS becomes wrong. Give the mapping a default value, or send a value with the event."
                )}
              </AlertDescription>
            </Alert>
          )}
          {sante.lastError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>
                {t("Last error, {quand}", { quand: relatif(sante.lastError.at) ?? sante.lastError.at })}
              </AlertTitle>
              <AlertDescription>
                <code className="break-words text-xs">{sante.lastError.message}</code>
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </div>
  );
}

function EtatChiffre({ label, valeur }: { label: string; valeur: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{valeur}</dd>
    </div>
  );
}
