"use client";

import { ArrowRight, TriangleAlert } from "lucide-react";
import { DateTime } from "luxon";
import { useExtracted } from "next-intl";
import type { AdsMapping } from "@/api/google-ads";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AUCUN_MONTANT, estSansMontant, formaterMontant } from "../montant";

/**
 * La liste des correspondances « événement → action de conversion ».
 *
 * En LECTURE seule à dessein : la création et la suppression vivent dans les
 * réglages du site, avec l'identifiant de compte et les interrupteurs. Deux
 * endroits pour créer la même chose, c'est la garantie qu'un des deux finira
 * par ne plus invalider le bon cache et affichera une liste périmée.
 */
export function Correspondances({ correspondances }: { correspondances: AdsMapping[] }) {
  const t = useExtracted();

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Event")}</TableHead>
            <TableHead>{t("Conversion action")}</TableHead>
            <TableHead className="text-right">{t("Default value")}</TableHead>
            <TableHead className="text-right">{t("Added")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {correspondances.map(correspondance => {
            const sansMontant = estSansMontant(correspondance.defaultValue);
            const ajoute = DateTime.fromISO(correspondance.createdAt);

            return (
              <TableRow key={correspondance.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{correspondance.eventName}</span>
                    <ArrowRight className="h-3 w-3 text-neutral-600 dark:text-neutral-400" aria-hidden />
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{correspondance.conversionActionId}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {sansMontant ? (
                    // Une correspondance sans montant n'est pas une erreur (un
                    // formulaire de contact n'a pas de prix), mais c'est elle
                    // qui alimente `zeroValueSent` et fausse le ROAS sans
                    // qu'aucune erreur ne soit levée. Elle doit se voir ici.
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="warning" className="gap-1">
                          <TriangleAlert className="h-3 w-3" />
                          {formaterMontant(correspondance.defaultValue, correspondance.currency) === AUCUN_MONTANT
                            ? t("No amount")
                            : formaterMontant(correspondance.defaultValue, correspondance.currency)}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t(
                          "These conversions reach Google with a value of zero. They are counted, but the return on ad spend Google reports will be understated."
                        )}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    formaterMontant(correspondance.defaultValue, correspondance.currency)
                  )}
                </TableCell>
                <TableCell className="text-right text-xs text-neutral-600 dark:text-neutral-400">
                  {ajoute.isValid ? ajoute.toRelative() : correspondance.createdAt}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
