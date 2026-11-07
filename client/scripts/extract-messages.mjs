import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unstable_extractMessages } from "next-intl/extractor";

const messagesDir = "./messages";

await unstable_extractMessages({
  srcPath: "./src",
  messages: {
    sourceLocale: "en",
    path: messagesDir,
    format: "json",
    locales: ["en", "de", "fr", "zh", "es", "pl", "it", "ko", "pt", "ja", "cs", "uk"],
  },
});

// 🔴 L'EXTRACTION DÉFAIT LE REBRAND, ET RIEN NE LE DIT SUR LE MOMENT.
//
// Les textes sources portent encore le nom de l'éditeur amont : ce sont les
// CLÉS d'extraction, on ne peut pas les réécrire sans orpheliner les douze
// catalogues. L'extracteur recopie donc « Rybbit » dans les VALEURS de
// en.json à chaque passage, et le rebrand fait à la main la fois d'avant
// disparaît en silence.
//
// Vécu le 02/09/2026 : un `npm run extract` légitime a réintroduit huit
// occurrences, et `scripts/check-brand.sh` a arrêté la construction en CI
// vingt minutes plus tard. Le contrôle a bien fait son travail ; le défaut
// est qu'il n'y avait rien pour l'empêcher de se reproduire à chaque
// extraction. D'où ce passage ici, dans l'outil lui-même : le rebrand cesse
// d'être une étape qu'on oublie.
//
// VALEURS SEULEMENT, JAMAIS LES CLÉS : une clé est un hachage du texte
// source, la toucher orphelinerait la traduction dans les douze langues.
const MARQUE_AMONT = /Rybbit/g;
const MARQUE = "Veridian";

for (const file of readdirSync(messagesDir)) {
  if (!file.endsWith(".json")) continue;
  const path = join(messagesDir, file);
  const data = JSON.parse(readFileSync(path, "utf8"));
  const sorted = Object.fromEntries(
    Object.keys(data)
      .sort()
      .map(k => [k, typeof data[k] === "string" ? data[k].replace(MARQUE_AMONT, MARQUE) : data[k]])
  );
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
}
