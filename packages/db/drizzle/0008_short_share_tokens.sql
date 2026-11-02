-- Share links get short tokens (8 chars, 48 random bits). Each live link with a long
-- token is replaced by a short copy; the old row is revoked, and revoked tokens keep
-- opening the document's current link, so URLs sent earlier still work.
INSERT INTO "share_links" ("document_id", "token", "role", "public", "guest_comments", "expires_at", "created_by")
SELECT "document_id",
       translate(encode(substring(uuid_send(gen_random_uuid()) from 1 for 6), 'base64'), '+/', '-_'),
       "role", "public", "guest_comments", "expires_at", "created_by"
FROM "share_links"
WHERE "revoked_at" IS NULL AND length("token") > 8;
--> statement-breakpoint
UPDATE "share_links" SET "revoked_at" = now() WHERE "revoked_at" IS NULL AND length("token") > 8;
