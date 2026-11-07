-- Dépenses publicitaires Google Ads, par site, par jour, par campagne.
--
-- POURQUOI CETTE TABLE
--
-- Le ticket d'origine du module (todo/2026-08-22) posait CINQ questions. Une
-- seule est couverte à ce jour : « quelles conversions Google a-t-il acceptées
-- ou rejetées ». Les quatre autres — combien a-t-on dépensé, quels visiteurs
-- viennent de cette dépense, quel chiffre d'affaires lui est attribuable, quel
-- ROAS — reposent toutes sur la même brique manquante : le COÛT.
--
-- Mesuré avant d'écrire cette table, le 2026-09-04, plutôt que supposé :
--   * deux comptes seulement dépensent sous le MCC Veridian sur 30 jours,
--     Societe A (N EUR, N clics) et Societe B (N EUR,
--     19 clics, 1 conversion) ; les onze autres sont à zéro ;
--   * et ce sont exactement les deux sites dont l'analytics porte du trafic
--     payant : site-a.fr (site N, N gclid) et site-b.fr (site N,
--     53 gclid). Tous les autres sites sont à zéro gclid.
-- La chaîne est donc joignable pour de vrais clients, aujourd'hui. Ce n'est pas
-- une brique posée en prévision d'un usage hypothétique.
--
-- CHOIX DE CONCEPTION, ET LEURS RAISONS
--
-- `cost_micros` en BIGINT et non un montant décimal : c'est l'unité que rend
-- l'API Google (millionièmes d'unité monétaire), et convertir à l'écriture
-- ferait perdre de la précision à chaque import puis la ferait diverger des
-- rapports Google. La conversion se fait à la lecture, une seule fois.
--
-- La devise est stockée PAR LIGNE : un compte Google Ads a la sienne, et un
-- même client peut en changer. Additionner des lignes de devises différentes
-- serait faux, et sans cette colonne rien ne l'empêcherait.
--
-- La clé primaire est (site_id, date, campaign_id) : l'import est idempotent
-- par nature, on peut le rejouer sur une période sans dupliquer. C'est
-- indispensable, parce que Google RÉVISE ses chiffres pendant plusieurs jours
-- après coup (clics invalides retirés, conversions attribuées en retard) : un
-- import qui ne saurait qu'ajouter figerait des chiffres faux.
CREATE TABLE IF NOT EXISTS "ads_cost_daily" (
  "site_id"       integer NOT NULL REFERENCES "sites"("site_id") ON DELETE CASCADE,
  "date"          date    NOT NULL,
  "campaign_id"   text    NOT NULL,
  "campaign_name" text    NOT NULL,
  "customer_id"   text    NOT NULL,
  "currency"      text    NOT NULL,
  "cost_micros"   bigint  NOT NULL DEFAULT 0,
  "impressions"   bigint  NOT NULL DEFAULT 0,
  "clicks"        bigint  NOT NULL DEFAULT 0,
  "conversions"   numeric(14,2) NOT NULL DEFAULT 0,
  "conversions_value" numeric(14,2) NOT NULL DEFAULT 0,
  "imported_at"   timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ads_cost_daily_pk" PRIMARY KEY ("site_id", "date", "campaign_id"),
  -- Les mêmes gardes qu'ailleurs dans ce module : un identifiant de compte est
  -- une suite de chiffres, et un montant négatif signale un bogue d'import, pas
  -- une dépense.
  CONSTRAINT "ads_cost_daily_customer_id_check" CHECK ("customer_id" ~ '^[0-9]+$'),
  CONSTRAINT "ads_cost_daily_cost_check" CHECK ("cost_micros" >= 0)
);

-- L'écran répond « combien sur telle période », donc on lit toujours par site
-- et par plage de dates. L'index primaire sert déjà ce chemin ; celui-ci sert
-- le balayage inverse, « quels sites ont dépensé récemment », dont a besoin
-- l'import pour savoir qui rafraîchir.
CREATE INDEX IF NOT EXISTS "ads_cost_daily_date_idx" ON "ads_cost_daily" ("date" DESC, "site_id");
