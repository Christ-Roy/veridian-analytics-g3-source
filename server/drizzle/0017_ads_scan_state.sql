-- Module Ads : le bilan du dernier passage du balayage, un enregistrement par site.
--
-- Pourquoi cette table existe, alors qu'un journal de conversions existe deja :
-- le journal ne peut compter que ce qui y est ENTRE. Or le balayage ecarte, et
-- il ecarte en amont. Un evenement sans consentement publicitaire n'est meme pas
-- cherche ; un nom d'evenement qu'aucune correspondance ne couvre n'est jamais
-- lu ; un convertisseur qui n'a jamais clique sur une annonce ne laisse rien.
-- Tout cela est legitime, et tout cela est invisible.
--
-- Sans cette table, un site configure, activate, dont CHAQUE evenement est
-- ecarte, affiche "0 en attente, 0 envoye" : exactement le meme ecran qu'un site
-- sans trafic. L'administrateur conclut au calme, et personne ne saura jamais
-- que la chaine ecarte tout.
--
-- Les trois etats que cette table separe, et qui se confondaient :
--
--   1. aucune ligne          le balayage n'a JAMAIS tourne. Une tache planifiee
--                            qui ne demarre pas n'a aucun autre temoin ;
--   2. events_examined = 0   site calme, rien a voir ;
--   3. events_examined > 0   la chaine voit du trafic et n'en tire rien :
--      et recorded = 0       configuration cassee, a regarder.
--
-- "unmapped_events" et "unmapped_top_names" servent la panne la plus banale :
-- une correspondance saisie "order_paid" alors que le site emet
-- "order_confirmed". Sans eux, cette faute de frappe produit un ecran calme.
--
-- Un seul enregistrement par site, ecrase a chaque passage : on veut le DERNIER
-- etat, pas un historique. Un historique demanderait une purge, un index
-- temporel et des decisions de retention, pour repondre a une question que
-- personne ne pose devant cet ecran.
--
-- "last_run_at" est de l'heure murale UTC, ecrite EXPLICITEMENT par l'appelant.
-- Ne jamais s'en remettre a un DEFAULT now() : il rend l'heure murale de la
-- SESSION Postgres, donc une base qui n'est pas en UTC daterait la ligne de
-- plusieurs heures, sans erreur, et l'ecran afficherait un dernier passage dans
-- le futur.

CREATE TABLE "ads_scan_state" (
	"site_id" integer PRIMARY KEY NOT NULL,
	"last_run_at" timestamp NOT NULL,
	"events_examined" integer DEFAULT 0 NOT NULL,
	"recorded" integer DEFAULT 0 NOT NULL,
	"already_known" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"skipped_no_consent" integer DEFAULT 0 NOT NULL,
	"skipped_no_click" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"unmapped_events" integer DEFAULT 0 NOT NULL,
	"unmapped_top_names" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ads_scan_state" ADD CONSTRAINT "ads_scan_state_site_id_sites_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("site_id") ON DELETE cascade ON UPDATE no action;