# Fork Veridian de Rybbit — G3 de l'analytics Veridian

> Base : [rybbit-io/rybbit](https://github.com/rybbit-io/rybbit) (AGPL-3.0)
> Commit de fork : `9ec40e2c` (2026-08-16)
> Date du fork : 2026-08-17 — décision Robert de remplacer l'applicatif G2 (fork staminads).
>
> Vue d'ensemble des 3 générations : `../ANALYTICS-GENERATIONS.md`

## Pourquoi ce fork existe

Rybbit **n'a aucun système de plugins applicatifs**. Les seuls « plugins » du
code sont ceux de better-auth (auth) et les `fastify.register()` (organisation
interne des routes). Toute extension Veridian vit donc dans ce fork, dans un
dossier de domaine, exactement comme upstream fait pour `server/src/api/gsc/`.

Un rebrand est également impossible sans fork : aucune variable d'environnement
de branding, « Rybbit » est en dur dans 27 fichiers du client.

## Ce qu'on N'A PAS à porter (déjà natif upstream)

Contrairement à G2, l'essentiel du custom Veridian devient inutile :

| Besoin Veridian | Chez Rybbit |
|---|---|
| Multi-tenant | `organization` / `member` / `invitation` / `team` + accès par site (better-auth) |
| API keys par tenant | table `apikey` scopée `referenceId`, quotas par plan |
| Lien de connexion | Plugin `magicLink` de better-auth, réutilisé par le rebond Hub (V007) |
| Search Console | `server/src/api/gsc/` complet + table `gsc_connections` |
| Français | `client/messages/fr.json` (12 langues, vouvoiement correct) |
| Session replay | `server/src/api/sessionReplay/` |
| Billing | `server/src/api/stripe/` |

## Patches Veridian

| ID | Description | Statut |
|---|---|---|
| V001 | CI build+push GHCR par environnement (`.github/workflows/veridian-build.yml`) | ✅ fait |
| V002 | Calls — ingestion `phone_call` serveur→serveur depuis la téléphonie | ⏳ à valider (cf risque ci-dessous) |
| V003 | `POST /api/admin/provision` — tenant + site + user + API key en un call (M2M, consommé par le Hub et le skill `analytics-provision`) | ⏳ à écrire |
| V004 | Rebrand Veridian (nom, logo, couleurs) | ⏳ |
| V005 | Alerte arrêt d'émission d'un workspace (angle mort constaté sur G2 : 3 clients ont cessé d'émettre sans que rien ne le signale) | ⏳ |
| V006 | `GET /api/users/by-email` — découverte Hub (HMAC, `server/src/api/veridian/`) : c'est ce qui fait apparaître la carte Analytics au tableau de bord d'un client. Nécessite `HUB_API_SECRET` | ✅ fait |
| V007 | `POST /api/sso/issue-magic-link` — rebond Hub (HMAC, `server/src/api/veridian/`) : le client connecté au Hub arrive ici sans mot de passe. Aucun fichier amont modifié hors l'enregistrement de route dans `server/src/index.ts` | ✅ en production, parcours Hub → tableau de bord mesuré le 2026-11-06 |
| V008 | `GET /api/hub/users` et `POST /api/hub/users/sync` : le Hub, seule source de vérité des utilisateurs (`CONTRAT-HUB` §3.8, HMAC, `server/src/api/veridian/`) | ✅ en production le 2026-11-07, `hub reconcile` à `ok` |
| V009 | Connexion automatique par le Hub, sans session : rebond, un seul essai, jamais après déconnexion ni en iframe (`client/src/lib/hubBounce.ts`) | ✅ code |

### V006 — découverte Hub, contrat

Le Hub appelle, à chaque connexion d'un utilisateur :

```
GET /api/users/by-email?email=<email>
X-Veridian-Timestamp:     <unix_ms>
X-Veridian-Hub-Signature: hex(hmac_sha256(HUB_API_SECRET, "{timestamp}."))
```

La charge signée est `{timestamp}.` — le corps vide d'un GET. Le chemin n'y
entre pas. Fenêtre anti-rejeu : 5 minutes.

Réponse `200 { found: true, user_email, workspaces: [...] }`, une entrée par
SITE visible par l'utilisateur ; `404 { found: false }` s'il est inconnu ou
n'a accès à aucun site. Le Hub traite l'absence de réponse comme « app
indisponible » et cache silencieusement la carte.

`HUB_API_SECRET` doit valoir exactement `ANALYTICS_HUB_API_SECRET` côté Hub.
Sans lui, l'endpoint refuse tout (500), il ne s'ouvre jamais par défaut.

`magic_link_capable` vaut `true` : le rebond V007 existe.

### V007 — rebond Hub, contrat

Conforme à `CONTRAT-HUB` §6bis.8.3 :

```
POST /api/sso/issue-magic-link
X-Veridian-Timestamp:     <unix_ms>
X-Veridian-Hub-Signature: hex(hmac_sha256(HUB_API_SECRET, "{timestamp}.{corps_brut}"))
{ "hub_user_id": "<id>", "email": "<adresse>" }
```

| Réponse | Cas |
|---|---|
| `200 { magic_link_url }` | lien à usage unique, valable 2 minutes |
| `400 { error: "user_not_in_app", hint }` | inconnu, banni ou sans site visible (même règle que V006) |
| `400 { error: "invalid_payload" }` | corps illisible, `hub_user_id` absent, adresse invalide |
| `400 { error: "hub_user_conflict" }` | compte déjà lié à un autre `hub_user_id` |
| `401` | signature absente ou fausse, horodatage à plus de 5 minutes |
| `429 { error: "rate_limited" }` | plus de 10 liens par minute et par utilisateur |
| `500` | `HUB_API_SECRET` absent, erreur d'infrastructure |

**Jointure.** `user.hub_user_id` (`text`, nullable, unique) est la clé immuable : un
email change. On résout d'abord par elle ; le repli par email ne sert qu'à rattacher un
compte encore sans lien, et seulement avec `email_proven: true` dans le corps signé. Puis
le lien est écrit. Un lien posé ne change jamais. Le format
n'est pas contraint à un UUID : c'est le Hub qui arbitre ce qu'il y met. Tout backfill
hors rebond doit vérifier que le compte Hub a une adresse prouvée.

**Le Hub garantit l'adresse.** Le lien connecte quiconque le Hub présente : c'est son
`denyUnlessEmailProven` (`hub:v0.5.40`) qui refuse un compte sans preuve. `hub_user_id`
vaut `hub_app.users.supabase_user_id`, jamais `users.id`.

Deux écarts assumés :

- **Le lien suit le chemin du plugin** (`/api/auth/magic-link/verify?token=`), pas
  `/auth/token?t=` : le Hub ne contrôle que l'hôte, et c'est le plugin qui consomme
  le jeton atomiquement et pose la session. Le handler écrit dans la table
  `verification` au format du plugin, qui n'est pas une API publique :
  `issueMagicLink.test.ts` fait l'aller-retour avec le vrai plugin. Il a déjà servi : la 1.7 a changé
  ce format (`magic-link:` en tête d'identifiant, champ `type`), et le test a rougi.
- **Pas de création d'utilisateur.** §3.7 règle 1 prévoit de créer l'utilisateur
  inconnu ; §6bis.8.3 impose ici `user_not_in_app`, qui prime pour le rebond.

**Limite de la vérification** : 120 par minute et par IP (`server/src/lib/magicLinkRateLimit.ts`, une
ligne dans `auth.ts`). Le plugin applique 3 par minute à l'envoi et à la vérification : un même bureau
sort par une seule IP, le 4e collègue recevait un 429. L'envoi de mails reste à 3.

**`@better-auth/sso` reste en dépendance sans être câblé** : `@better-auth/infra`
l'importe en dur (`dist/index.mjs`, ligne 12), et `auth.ts` charge `infra` au démarrage.
Le retirer empêche ce module de se charger (`ERR_MODULE_NOT_FOUND`, mesuré le 2026-11-06).

Le rattachement pose aussi `emailVerified: true`. Sans ça, le plugin supprimerait le mot
de passe et les sessions du compte à la vérification (`revokeUnprovenAccountAccess`) :
6 comptes de prod sur 7 sont `emailVerified: false` (mesuré le 2026-11-06), dont
l'owner. La fermeture de la connexion par mot de passe se décide à part.

### V008 — synchro Hub, contrat

`GET /api/hub/users` : `{ users: [{ hub_user_id, email, name }] }`. Les comptes sans lien y
figurent avec `hub_user_id: null`, c'est ce que `hub reconcile` doit voir, y compris
`audit-ui`, le secours opérateur. Seuls les comptes supprimés par le Hub en sortent.

`POST /api/hub/users/sync` : `{ hub_user_id, name?, email?, deleted? }`, compte retrouvé par
`hub_user_id` uniquement. 200 `{ updated: true | false }`, idempotent. 404 `user_not_in_app`
(corps exact : sinon le Hub lit `endpoint_missing`), 409 `email_conflict`, 400 `invalid_payload`.

`deleted: true` ne supprime aucune ligne : bannissement (`banReason: "hub_deleted"`), sessions
supprimées, clés API personnelles désactivées. Les clés d'organisation restent. Le rétablissement
n'existe pas : il passe par une reprise manuelle, le Hub n'envoie jamais `deleted: false`.

### V009 — connexion automatique par le Hub

`CONTRAT-HUB` §6bis.8.0, dans `client/src/lib/hubBounce.ts` et `AuthenticationGuard`. Une page protégée
visitée sans session renvoie à `<hub>/api/auth/bounce/prepare?next=<page>&auto=1`, puis le Hub ramène sur
cette page (`next` de `issue-magic-link`, accepté seulement sur l'origine de l'application).

Sans rebond, donc la page de connexion, avec mot de passe et bouton « Continuer » : après une déconnexion
explicite (cookie `veridian-logout`), après un essai raté (cookie `veridian-bounce-try`, 5 minutes), dans une
iframe, hors plateforme Veridian. Les sites publics et les liens privés ne sont pas concernés. Les deux
cookies tombent à la première connexion réussie.

`revoke_sessions: true` sur `/api/hub/users/sync` coupe les sessions, sans toucher au compte ni aux clés API.

### Better Auth 1.7 : le plugin MCP OAuth est retiré

Passé à 1.7.18 pour corriger GHSA-965c-763c-88jm et ses deux voisines. Le plugin `mcp` est sorti du paquet et
demandait un nouveau socle OAuth et ses tables, pour **aucun client en production** (0 application et 0 jeton
OAuth, mesuré le 2026-11-07). Le serveur MCP reste, authentifié par clé API. Les routes `/.well-known/oauth-*`
répondent 404. Les tables `oauth*` restent, vides. Pour rétablir l'OAuth : `@better-auth/mcp` et sa migration.

## 🔴 Risque numéro un à lever avant tout le reste

**Le bot-blocking peut manger nos events `phone_call`.** Rybbit a un
`server/src/services/tracker/botBlocking/` avec scoring (`_bs`, `_bsm`, ASN
datacenter, anti-LLM-crawler). Nos appels téléphoniques arrivent **du serveur**,
sans navigateur, depuis une IP de datacenter. S'ils sont filtrés, la feature
différenciante Veridian meurt en silence.

Le schéma d'ingestion accepte bien ce dont on a besoin
(`server/src/services/tracker/trackingPayload.ts`) :

```
type: "custom_event"
event_name: "phone_call"
properties: '{"source":"seo","phone_number_e164":"+33..."}'   // JSON, max 2048
user_id / anonymous_id / ip_address / user_agent              // surchargeables
```

→ Test à faire en premier sur le staging monté ci-dessous.

## ⚠️ Piège de build (déjà câblé, ne pas le défaire)

Le client Next.js **inline `NEXT_PUBLIC_BACKEND_URL` dans le bundle au moment du
build** (`client/Dockerfile`, ARG lignes 28-40). Une image cliente est donc liée
à UN environnement. Le workflow `veridian-build.yml` construit une image par
branche (staging / main) et **vérifie le bundle produit** avant de le considérer
bon. Ne jamais réutiliser une image cliente d'un environnement dans l'autre.

## Télémétrie upstream

Coupée via `DISABLE_TELEMETRY=true` dans le job Nomad.

Ce qu'elle envoyait (`server/src/services/telemetryService.ts`, cron quotidien) :
un identifiant d'instance (hash SHA-256 du secret), la version, le nombre de
lignes des tables et la taille ClickHouse. **Aucune donnée visiteur, aucune URL,
aucun domaine client.** Ils n'abusent pas ; on la coupe quand même parce qu'on
revend le service et qu'on n'a pas à publier nos volumes clients.

## Licence

AGPL-3.0, comme upstream et comme G2. Ne pas retirer `LICENSE.md` ni les
copyrights. Le service étant servi par le réseau, un client qui demande les
sources y a droit.

## Synchronisation upstream

```bash
git fetch upstream
git cherry-pick <sha>     # bugfix ciblé — préféré au rebase complet
```
