-- Module Ads : les trois tables du journal de conversions.
--
-- Le module n'ajoute rien au chemin d'ingestion : il lit ce qui est deja mesure
-- et ecrit ici les conversions a renvoyer a Google. Aucun jeton client n'est
-- stocke, les identifiants du compte administrateur vivent dans la config
-- serveur (cf. todo/2026-08-29-conception-module-ads.md).
--
-- Ce qui merite d'etre lu avant de toucher a ce fichier :
--
--   * la contrainte "ads_conversion_outbox_idempotence_unique" est le coeur du
--     dispositif. Le triplet (site, evenement metier, action de conversion) sert
--     aussi de transactionId cote Google : un rejeu ne peut donc compter deux
--     fois une conversion, ni ici, ni la-bas. Une conversion comptee deux fois
--     fausse les encheres sans jamais lever d'erreur ;
--   * "click_at" est l'instant du CLIC, distinct de "occurred_at" qui est celui
--     de la conversion. La fenetre de 90 jours de Google porte sur l'age du
--     CLIC : un clic plus vieux recoit un HTTP 200 et n'est jamais compte. Une
--     conversion ecrite avec un clic de 88 jours, puis retardee par quelques
--     echecs transitoires, sortirait de la fenetre pendant l'attente ; sans
--     cette colonne rien ne pourrait le voir. Controler sur "occurred_at" ne
--     marche pas : il est toujours posterieur au clic, donc on sous-estimerait
--     l'age a chaque fois, et le controle serait vert et faux ;
--   * "status" separe 'failed' (Google a refuse, ou nous avons renonce : 400/403/
--     404, message impossible a construire, budget de reprises epuise) et
--     'skipped' (on a decide de ne pas envoyer : consentement refuse, clic hors
--     fenetre, mode d'essai avec un identifiant reel, site desactive). Les
--     confondre ferait monter un compteur d'echecs alors que rien n'est casse ;
--   * "click_id" ne peut pas etre vide. NOT NULL ne l'interdit pas, or un
--     identifiant vide fait echouer la construction du message AVANT tout appel
--     reseau, ce qui condamnait tout son lot en echec definitif ;
--   * tout horodatage de "ads_conversion_outbox" est en UTC, et l'appelant
--     l'ecrit EXPLICITEMENT. Les colonnes sont des "timestamp" SANS fuseau,
--     comme partout dans ce schema, et "now()" y ecrit l'heure MURALE de la
--     session Postgres : deux insertions simultanees sous TimeZone = 'UTC' puis
--     'Europe/Paris' sont enregistrees a deux heures d'ecart, sans le moindre
--     avertissement. Une ligne datee dans le futur reste invisible au drain,
--     puis repart toute seule ; un "occurred_at" ou un "click_at" decale part
--     fausse chez Google. Le DEFAULT now() est un filet, jamais une source ;
--   * "test_mode" par site est un garde-fou anti-fausse-conversion : sur un
--     environnement d'essai les identifiants Ads pointent la VRAIE campagne, donc
--     seuls les identifiants de clic prefixes TEST_ ont le droit de partir ;
--   * le consentement est fige au moment de l'evenement, pas relu a l'envoi :
--     Google repond 200 a un evenement marque CONSENT_DENIED, le blocage est
--     donc chez nous ou nulle part.
--
-- Les cles etrangeres sont declarees en ligne, et non par ALTER TABLE : Postgres
-- ne connait pas ADD CONSTRAINT IF NOT EXISTS, la migration ne serait pas
-- rejouable. Les noms de contraintes restent ceux qu'attend le snapshot drizzle.
CREATE TABLE IF NOT EXISTS "ads_site_settings" (
	"site_id" integer PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"test_mode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ads_site_settings_site_id_sites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("site_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "ads_site_settings_customer_id_check" CHECK ("ads_site_settings"."customer_id" ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_conversion_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"event_name" text NOT NULL,
	"conversion_action_id" text NOT NULL,
	"default_value" numeric(14, 2),
	"currency" text DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ads_conversion_mappings_site_id_sites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("site_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "ads_conversion_mappings_site_event_unique" UNIQUE("site_id","event_name"),
	CONSTRAINT "ads_conversion_mappings_action_id_check" CHECK ("ads_conversion_mappings"."conversion_action_id" ~ '^[0-9]+$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ads_conversion_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"business_event_id" text NOT NULL,
	"conversion_action_id" text NOT NULL,
	"click_id_type" text NOT NULL,
	"click_id" text NOT NULL,
	"click_at" timestamp NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"value" numeric(14, 2),
	"currency" text DEFAULT 'EUR' NOT NULL,
	"consent_ad_user_data" text NOT NULL,
	"consent_ad_personalization" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp,
	"google_request_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ads_conversion_outbox_site_id_sites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("site_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "ads_conversion_outbox_idempotence_unique" UNIQUE("site_id","business_event_id","conversion_action_id"),
	CONSTRAINT "ads_conversion_outbox_status_check" CHECK ("ads_conversion_outbox"."status" IN ('pending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "ads_conversion_outbox_click_id_type_check" CHECK ("ads_conversion_outbox"."click_id_type" IN ('gclid', 'gbraid', 'wbraid')),
	CONSTRAINT "ads_conversion_outbox_click_id_check" CHECK ("ads_conversion_outbox"."click_id" <> '')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_conversion_mappings_site_idx" ON "ads_conversion_mappings" USING btree ("site_id");--> statement-breakpoint
-- L'index du drain, et lui seul : les lignes en attente dont l'echeance est
-- passee. Partiel, parce que les lignes envoyees, echouees ou ecartees
-- s'accumulent sans jamais etre relues par le drain et n'ont aucune raison de
-- peser sur l'index.
CREATE INDEX IF NOT EXISTS "ads_conversion_outbox_drain_idx" ON "ads_conversion_outbox" USING btree ("next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ads_conversion_outbox_site_status_idx" ON "ads_conversion_outbox" USING btree ("site_id","status");
