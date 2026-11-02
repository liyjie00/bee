CREATE TABLE "document_embeds" (
	"document_id" uuid NOT NULL,
	"embedded_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_embeds_document_id_embedded_id_pk" PRIMARY KEY("document_id","embedded_id")
);
--> statement-breakpoint
ALTER TABLE "document_embeds" ADD CONSTRAINT "document_embeds_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_embeds" ADD CONSTRAINT "document_embeds_embedded_id_documents_id_fk" FOREIGN KEY ("embedded_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_embeds" ADD CONSTRAINT "document_embeds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_embeds_embedded_idx" ON "document_embeds" USING btree ("embedded_id");