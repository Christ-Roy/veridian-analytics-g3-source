ALTER TABLE "team" ADD COLUMN "memberCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "teamMember" ADD COLUMN "membershipKey" text;--> statement-breakpoint
ALTER TABLE "teamMember" ADD CONSTRAINT "teamMember_membershipKey_unique" UNIQUE("membershipKey");--> statement-breakpoint
UPDATE "team" SET "memberCount" = (SELECT count(*) FROM "teamMember" WHERE "teamMember"."teamId" = "team"."id");
