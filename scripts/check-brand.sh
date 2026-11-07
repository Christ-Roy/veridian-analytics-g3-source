#!/usr/bin/env bash
# Garde-fou de marque — ce qui rend le rebrand maintenable dans la durée.
#
# Le problème d'un rebrand par rechercher/remplacer, c'est qu'il se défait tout
# seul : chaque `git cherry-pick` depuis l'amont réintroduit des mentions de
# l'éditeur, et personne ne s'en aperçoit avant qu'un client les voie.
#
# Ce contrôle échoue si une marque VISIBLE réapparaît dans l'interface. Après
# une synchro amont, il dit exactement quoi rebrander.
#
# ⚠️ Il ignore délibérément les identifiants TECHNIQUES, qui DOIVENT garder le
# nom amont : `window.rybbit` (contrat public du tracker déjà posé chez les
# clients), `@rybbit/shared`, `@rybbit/react`, et les composants RybbitLogo /
# RybbitTextLogo (noms internes jamais vus par un client).
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# Exceptions assumées, et pourquoi :
#   - client/src/lib/const.ts (DEMO_HOSTNAME) et lib/stripe.ts : ce sont des
#     COMPARAISONS d'hôte servant à détecter le cloud de l'éditeur. Jamais vraies
#     sur notre instance, jamais affichées. Les modifier changerait une logique
#     sans rien gagner.
#   - useIsProduction.ts : idem.
#   - les clés de traduction t("... Rybbit ...") : le texte anglais SERT de clé.
#     Les valeurs, elles, sont déjà rebrandées dans client/messages/*.json.
#     Toucher la clé casserait le lien vers la traduction.
echo "▸ marque visible dans l'interface"
# Sont cherchées : les mentions affichées et les liens vers l'éditeur.
hits=$(grep -rn -E "Rybbit|rybbit\.(com|io)|/rybbit/" \
        client/src \
        --include='*.tsx' --include='*.ts' 2>/dev/null \
    | grep -v -E "@rybbit/|window\.rybbit|rybbit\.(init|event|flag|identify|onReady)" \
    | grep -v -E "RybbitLogo|RybbitTextLogo" \
    | grep -v -E "client/src/lib/(brand|rybbit\.d)\.ts" \
    | grep -v -E "plausibleParser" \
    | grep -v -E 't\("[^"]*Rybbit' \
    | grep -v -E '"[^"]*Rybbit[^"]*",?$' \
    | grep -v -E "useIsProduction" \
    | grep -v -E "lib/(const|stripe)\.ts" \
    | grep -v -E "^\S+: *(//|\*|/\*)" \
    || true)

if [ -n "$hits" ]; then
  echo "$hits" | sed 's/^/  ✗ /'
  n=$(echo "$hits" | wc -l)
  echo "  → $n occurrence(s). Passer par client/src/lib/brand.ts (BRAND.*)."
  fail=1
else
  echo "  ✓ aucune"
fi

echo "▸ marque visible dans ce que le SERVEUR envoie au client"
# `server/src` n'était pas scanné du tout. C'est pourtant de là que sortent les
# documents que le client GARDE : le rapport PDF exporté portait encore
# « Powered by Rybbit » en pied de chaque page.
#
# Périmètre restreint aux surfaces qui atteignent un client. Exclusions,
# toutes assumées :
#   - identifiants TECHNIQUES : `RybbitEvent`, `RybbitAPI`, `RybbitApiClient`,
#     le namespace `window.rybbit` et les mappeurs d'import. Même règle que côté
#     client : les renommer casserait un contrat, pas une marque ;
#   - `server/src/mcp/` : descriptions d'outils lues par un agent ;
#   - `server/src/analytics-script/` : le tracker, dont l'API publique EST
#     `window.rybbit` chez tous nos clients déjà installés ;
#   - les invites du générateur SQL (`generateCustomQuery`, `eventSchema`) :
#     texte envoyé au modèle, jamais affiché ;
#   - DETTE CONNUE, e-mails sortants (`lib/email/`, `reengagement/`,
#     `onboardingTips/`) : ils portent encore la marque ET le domaine d'envoi de
#     l'amont. Ils ne partent pas — `RESEND_API_KEY` n'est pas configurée en
#     production — donc rien ne fuit aujourd'hui. Le jour où l'envoi est
#     branché, les rebrander AVANT et retirer cette exclusion dans le même
#     changement, sinon nos clients reçoivent des e-mails signés par l'éditeur.
srv=$(grep -rn -E "Rybbit" server/src \
        --include='*.ts' --include='*.tsx' 2>/dev/null \
      | grep -v -E "^server/src/(mcp|analytics-script|lib/email|services/(reengagement|onboardingTips|import))/" \
      | grep -v -E "\.test\.tsx?:" \
      | grep -v -E "server/src/lib/brand\.ts" \
      | grep -v -E "Rybbit(Event|API|ApiClient|ApiError)\b" \
      | grep -v -E "server/src/api/analytics/(generateCustomQuery|utils/eventSchema)\.ts" \
      | grep -v -E "^[^:]+:[0-9]+: *(//|\*|/\*)" \
      || true)
if [ -n "$srv" ]; then
  echo "$srv" | sed 's/^/  ✗ /'
  echo "  → passer par server/src/lib/brand.ts (BRAND.*)."
  fail=1
else
  echo "  ✓ aucune"
fi

echo "▸ appels sortants vers l'éditeur"
# Une console qui appelle l'éditeur fuite l'usage de nos clients.
net=$(grep -rn -E "https?://[a-z.]*rybbit\.(com|io)" client/src server/src \
        --include='*.ts' --include='*.tsx' 2>/dev/null \
      | grep -v -E "^\S+: *(//|\*|/\*)" \
      | grep -v "eslint-disable-next-line no-unreachable" \
      | grep -v -E "\.test\.ts" \
      | grep -v "telemetryService" || true)
if [ -n "$net" ]; then
  echo "$net" | sed 's/^/  ✗ /'
  echo "  → un appel réseau vers l'éditeur expose nos clients. Le retirer."
  fail=1
else
  echo "  ✓ aucun"
fi

echo "▸ appels sortants vers un TIERS"
# Le contrôle précédent ne regardait que l'éditeur amont. Or ce qui expose nos
# clients, ce n'est pas la marque : c'est le fait d'appeler QUI QUE CE SOIT
# depuis une console d'analytics. Trois fuites réelles avaient survécu au
# rebrand — icônes chez DuckDuckGo, métadonnées de page chez Microlink, icônes
# chez Google dans les PDF et les e-mails — parce que rien ne les cherchait.
#
# Un service vendu « sans cookie, hébergé en France » ne peut pas annoncer à un
# tiers la liste des domaines que ses clients mesurent, ni leurs référents, ni
# le moment où ils ouvrent leur rapport.
#
# Sont tolérés, et seulement eux :
#   - Google OAuth / API Search Console : le client CONSENT explicitement en
#     connectant sa propriété, c'est le service lui-même ;
#   - Stripe et AppSumo : code amont mort ici, sous `if (IS_CLOUD)` ;
#   - OpenRouter : appelé seulement si une clé est posée, aucune sur l'instance ;
#   - Mapbox et flagcdn : rendu cartographique, actif seulement si MAPBOX_TOKEN
#     est posé — aucun ne l'est en production ;
#   - raw.githubusercontent.com : téléchargement d'une liste d'ASN publics, il
#     ne PART aucune donnée client ;
#   - api.brevo.com : notre PROPRE routeur d'e-mails transactionnels, appelé
#     depuis server/src/lib/email/email.ts pour livrer les liens de connexion,
#     les invitations et les vérifications d'adresse. Ce n'est pas une fuite :
#     un e-mail doit bien partir par quelque part, et l'adresse du destinataire
#     est précisément ce qu'on lui confie. À reconsidérer le jour où l'envoi
#     passera par le relai Postfix auto-hébergé.
#     🔴 Cette omission a cassé la construction des images pendant huit jours
#     (2026-08-21 au 2026-08-29) : l'appel Brevo est arrivé avec les liens
#     magiques, le contrôle l'a refusé, et la CI échouait en quatre secondes
#     AVANT le moindre build. Quatre poussées d'affilée en échec sans que
#     personne le voie — un contrôle qui bloque tout n'alerte personne.
#   - googleads.googleapis.com : l'API Google Ads CLASSIQUE, appelée DEPUIS LE
#     SERVEUR pour LIRE les rapports de dépense (server/src/api/ads/couts.ts).
#     C'est un hôte différent de `datamanager` ci-dessous et ce n'est pas une
#     redondance : depuis juin 2026 Google a séparé l'ENVOI de conversions (Data
#     Manager) de la LECTURE de rapports (API Ads), avec des hôtes, des en-têtes
#     et des scopes différents. Même justification pour les deux : le client
#     connecte lui-même son compte, et l'appel ne part jamais du navigateur.
#     Ajouté ici dans le MÊME commit que l'appel, comme le dit le paragraphe
#     ci-dessous — c'est la troisième fois que ce contrôle arrêterait toute
#     publication d'image sur un appel parfaitement légitime.
#   - datamanager.googleapis.com : l'API Google Ads Data Manager, appelée
#     DEPUIS LE SERVEUR pour renvoyer les conversions (server/src/api/ads/).
#     Même famille que l'OAuth et la Search Console ci-dessus : c'est un
#     service que le client connecte lui-même, et l'appel ne part jamais du
#     navigateur. L'exclusion reste NOMMÉE sous-domaine par sous-domaine et
#     non élargie à `*.google.com` : l'élargir rouvrirait exactement la fuite
#     d'icônes Google dans les PDF et les e-mails que ce contrôle a fermée.
#   - *.testutil.ts : utilitaires de TEST (téléchargement du binaire
#     `clickhouse local` depuis clickhouse.com). Le filtre ne couvrait que
#     `*.test.ts`, donc ces fichiers étaient traités comme du code livré alors
#     qu'aucun n'entre dans une image : ni server/Dockerfile ni
#     client/Dockerfile ne les embarquent.
#
#   🔴 Ces deux-là ont de nouveau cassé la construction le 01/09/2026, dans les
#   heures suivant leur arrivée. C'est la DEUXIÈME fois que ce contrôle bloque
#   toute publication d'image sur un appel légitime. Il est bien placé — il doit
#   rester avant le build — mais quiconque ajoute un appel sortant doit venir
#   ici dans le MÊME commit, sinon la chaîne s'arrête pour tout le monde.
third_party=$(grep -rn -E "https?://[a-zA-Z0-9.-]+" client/src server/src \
        --include='*.ts' --include='*.tsx' 2>/dev/null \
      | grep -v -E "\.test\.tsx?:" \
      | grep -v -E "\.testutil\.tsx?:" \
      | grep -v -E "^[^:]+:[0-9]+: *(//|\*|/\*)" \
      | grep -oE "^[^:]+:[0-9]+|https?://[a-zA-Z0-9.-]+" \
      | awk '/^https?:/ { if (loc != "") print loc " " $0; next } { loc = $0 }' \
      | grep -v -E " https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)" \
      | grep -v -E " https?://([a-z0-9-]+\.)*veridian\.site" \
      | grep -v -E " https?://(www\.)?(schema\.org|w3\.org|example\.com)" \
      | grep -v -E " https?://(www\.)?openstreetmap\.org" \
      | grep -v -E " https?://(accounts|oauth2|www|datamanager|googleads)\.google(apis)?\.com" \
      | grep -v -E " https?://(api\.)?stripe\.com| https?://appsumo\.com" \
      | grep -v -E " https?://openrouter\.ai" \
      | grep -v -E " https?://(api|docs)\.mapbox\.com| https?://flagcdn\.com" \
      | grep -v -E " https?://(raw\.githubusercontent|github)\.com" \
      | grep -v -E " https?://api\.brevo\.com" \
      | grep -v -E " https?://(www\.)?maxmind\.com| https?://carto\.com" \
      | grep -v -E " https?://[a-z.]*rybbit\.(com|io)" \
      | sort -u \
      || true)

# Ce qui reste est soit une fuite, soit une exception à assumer ICI, en clair.
if [ -n "$third_party" ]; then
  echo "$third_party" | sed 's/^/  ✗ /'
  echo "  → un appel vers un tiers depuis la console expose nos clients."
  echo "    Le retirer, ou l'assumer explicitement dans ce contrôle."
  fail=1
else
  echo "  ✓ aucun"
fi

echo "▸ pas de service d'ICÔNES tiers"
# Le piège récurrent : l'icône d'un domaine paraît cosmétique, mais la demander
# à un tiers lui livre la carte d'acquisition complète de nos clients. Les deux
# `lib/favicon.ts` (client et serveur) sont la seule façon d'en produire une.
icons=$(grep -rn -E "icons\.duckduckgo\.com|/s2/favicons|logo\.clearbit\.com|favicone\.com|api\.microlink\.io" \
          client/src server/src --include='*.ts' --include='*.tsx' 2>/dev/null \
        | grep -v -E "lib/favicon\.ts" \
        | grep -v -E "^\S+: *(//|\*|/\*)" || true)
if [ -n "$icons" ]; then
  echo "$icons" | sed 's/^/  ✗ /'
  echo "  → passer par faviconUrl() de lib/favicon.ts (icône servie par le domaine lui-même)."
  fail=1
else
  echo "  ✓ aucun"
fi

echo "▸ traductions"
tr_hits=$(grep -l "Rybbit" client/messages/*.json 2>/dev/null || true)
if [ -n "$tr_hits" ]; then
  echo "$tr_hits" | sed 's/^/  ✗ /'
  echo "  → relancer le rebrand des messages (valeurs seulement, jamais les clés)."
  fail=1
else
  echo "  ✓ aucune"
fi

echo "▸ BRAND toujours importé là où il est utilisé"
# Un BRAND. sans import casse la construction — autant l'attraper ici plutôt
# qu'après dix minutes de build.
orphans=$(grep -rl -E "\bBRAND\." client/src server/src --include='*.ts' --include='*.tsx' 2>/dev/null \
  | grep -v "lib/brand.ts" \
  | while read f; do grep -qE "^import \{[^}]*\bBRAND\b" "$f" || echo "$f"; done)
if [ -n "$orphans" ]; then
  echo "$orphans" | sed 's/^/  ✗ import manquant : /'
  fail=1
else
  echo "  ✓ tous importés"
fi

echo "▸ le contrat technique du tracker est INTACT"
# L'inverse du reste : ici, une DISPARITION est le défaut. Renommer window.rybbit
# casserait tous les snippets déjà installés sur les sites clients.
if grep -rq "window.rybbit" client/src server/src 2>/dev/null; then
  echo "  ✓ window.rybbit préservé"
else
  echo "  ✗ window.rybbit a disparu — les snippets clients en production casseraient"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "✓ marque conforme" || echo "✗ marque non conforme"
exit "$fail"
