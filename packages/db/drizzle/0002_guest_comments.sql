ALTER TABLE "comment_threads" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "author_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "guest_name" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "guest_key_hash" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "share_link_id" uuid;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "guest_comments" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_share_link_id_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_links"("id") ON DELETE set null ON UPDATE no action;