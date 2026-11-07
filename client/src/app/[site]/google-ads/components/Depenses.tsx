"use client";

import { useExtracted } from "next-intl";
import type { AdsCoutCampagne, AdsCoutTotal, AdsTraficPaye } from "@/api/google-ads";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formaterMontant } from "../montant";

/**
 * Ce que ce site a dépensé en publicité, et sur quelles campagnes.
 *
 * C'est la première des cinq questions du ticket d'origine du module, et la
 * seule des quatre restantes qui se réponde sans rattacher un clic à une
 * session. Les trois autres (visiteurs venus de la dépense, revenu attribué,
 * ROAS) en dépendent : sans coût, aucune n'a de dénominateur.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 UN TOTAL PAR DEVISE, JAMAIS UN SEUL NOMBRE.
 *
 * Un compte Google Ads a sa devise et un client peut en changer. Aplatir ces
 * lignes en une somme donnerait un chiffre parfaitement plausible et
 * parfaitement faux — le genre de chiffre sur lequel on décide d'un budget. La
 * forme des données l'interdit ; cet écran se contente de ne pas la contourner.
 *
 * 🔴 CE QUI EST AFFICHÉ EST CE QUI A ÉTÉ IMPORTÉ, ET L'IMPORT S'ARRÊTE À HIER.
 *
 * Le jour en cours est partiel chez Google : l'inclure ferait afficher une
 * dépense qui BAISSE d'heure en heure, ce qui se lit comme un bogue. La période
 * affichée le dit, plutôt que de laisser deviner pourquoi aujourd'hui manque.
 */
export function Depenses({
  totaux,
  campagnes,
  trafic,
  debut,
  fin,
  chargement,
}: {
  totaux: AdsCoutTotal[];
  campagnes: AdsCoutCampagne[];
  trafic: AdsTraficPaye | null;
  debut: string;
  fin: string;
  chargement: boolean;
}) {
  const t = useExtracted();

  if (chargement) {
    return (
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  // Aucune dépense n'est un ÉTAT NORMAL, pas une panne : la plupart des sites
  // mesurés ne font pas de publicité. Le dire explicitement évite la question
  // « pourquoi c'est vide », qui coûte un aller-retour à chaque fois.
  //
  // 🔴 MAIS ON NE SORT QUE SI LE TRAFIC PAYANT EST VIDE AUSSI.
  //
  // Première version : cette sortie précoce se déclenchait dès que la dépense
  // manquait, et emportait avec elle le bloc du trafic payé. Constaté sur le
  // staging le 2026-09-05 — l'écran annonçait « aucune dépense » alors qu'une
  // session payante sur dix-huit était bien mesurée et affichée par l'API.
  //
  // C'est exactement le cas où l'information compte le plus : import de coût
  // pas encore passé, en retard ou en échec, pendant que des visiteurs payés
  // arrivent. Masquer le second parce que le premier manque revient à cacher le
  // symptôme au moment où il apparaît.
  const sansDepense = totaux.length === 0;
  const sansTrafic = !trafic || trafic.sessionsPayantes === 0;
  if (sansDepense && sansTrafic) {
    return (
      <Card>
        <CardContent className="pt-4">
          <h2 className="text-sm font-medium mb-1">{t("Ad spend")}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t("No spend recorded over this period. This is normal for a site with no active campaign.")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-4 space-y-4">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-medium">{t("Ad spend")}</h2>
          <span className="text-xs text-neutral-600 dark:text-neutral-400">
            {t("{debut} to {fin}, excluding today", { debut, fin })}
          </span>
        </div>

        <div className="flex flex-wrap gap-4">
          {sansDepense && (
            /* La dépense manque mais du trafic payé arrive : c'est un signal,
               pas un vide. Le dire ici plutôt que de laisser une zone blanche
               au-dessus de chiffres qui, eux, existent. */
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {t("No spend recorded over this period. This is normal for a site with no active campaign.")}
            </p>
          )}
          {totaux.map(total => (
            <div key={total.currency} className="min-w-[9rem]">
              <div className="text-2xl font-semibold">
                {formaterMontant(total.costMicros / 1_000_000, total.currency)}
              </div>
              <div className="text-xs text-neutral-600 dark:text-neutral-400">
                {t("{clicks} clicks, {impressions} impressions", {
                  clicks: total.clicks.toLocaleString(),
                  impressions: total.impressions.toLocaleString(),
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Ce que la dépense a acheté. Séparé des campagnes à dessein : le
            client ne demande pas « quelles campagnes » mais « est-ce que ça
            sert ». */}
        {trafic && (
          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 p-3 space-y-2">
            <div className="text-sm">
              {t("{sessions} visits from ads, out of {total}", {
                sessions: trafic.sessionsPayantes.toLocaleString(),
                total: trafic.sessionsTotal.toLocaleString(),
              })}
            </div>
            {trafic.actions.length > 0 ? (
              <ul className="text-sm text-neutral-600 dark:text-neutral-400 space-y-1">
                {trafic.actions.map(a => (
                  <li key={a.nom}>
                    {t("{nom}: {total} ({sessions} visits)", {
                      nom: a.nom,
                      total: a.total.toLocaleString(),
                      sessions: a.sessions.toLocaleString(),
                    })}
                  </li>
                ))}
              </ul>
            ) : (
              /* Zéro action sur du trafic payé est le constat le plus utile de
                 cet écran, et le plus facile à confondre avec un écran vide.
                 On l'écrit. */
              <p className="text-sm text-amber-700 dark:text-amber-500">
                {t("These paid visits produced no tracked action over the period.")}
              </p>
            )}
            {/* 🔴 POURQUOI IL N'Y A PAS DE ROAS ICI. Aucun événement mesuré ne
                porte de montant : le calculer diviserait une dépense réelle par
                un revenu toujours nul et afficherait « 0 », un nombre qui a
                l'air calculé et ne mesure rien. Le dire vaut mieux que
                l'afficher. */}
            <p className="text-xs text-neutral-500">
              {t("Return on ad spend is not shown: no tracked event carries an amount.")}
            </p>
          </div>
        )}

        {campagnes.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Campaign")}</TableHead>
                  <TableHead className="text-right">{t("Cost")}</TableHead>
                  <TableHead className="text-right">{t("Clicks")}</TableHead>
                  <TableHead className="text-right">{t("Conversions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campagnes.map(c => (
                  <TableRow key={`${c.campaignId}-${c.currency}`}>
                    <TableCell className="font-medium">{c.campaignName || c.campaignId}</TableCell>
                    <TableCell className="text-right">
                      {formaterMontant(c.costMicros / 1_000_000, c.currency)}
                    </TableCell>
                    <TableCell className="text-right">{c.clicks.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{c.conversions.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
