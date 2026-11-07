ALTER TABLE "user" ADD COLUMN "hub_user_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_hub_user_id_unique" UNIQUE("hub_user_id");