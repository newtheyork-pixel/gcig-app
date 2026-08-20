-- The RFC 5322 Message-ID, so a reply can quote it in In-Reply-To.
-- Same trap as the migration above: the table is OutreachReply.
ALTER TABLE "OutreachReply" ADD COLUMN "rfcMessageId" TEXT;
