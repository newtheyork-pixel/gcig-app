-- An inbox without subject lines is a list of people, not messages.
ALTER TABLE "OutreachMessage" ADD COLUMN "subject" TEXT;
