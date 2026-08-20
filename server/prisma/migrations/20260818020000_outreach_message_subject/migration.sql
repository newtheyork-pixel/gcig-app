-- An inbox without subject lines is a list of people, not messages.
-- NOTE: the Prisma model is OutreachMessage, but the physical table kept its
-- original name via @@map("OutreachReply"). Always ALTER the table, not the model.
ALTER TABLE "OutreachReply" ADD COLUMN "subject" TEXT;
