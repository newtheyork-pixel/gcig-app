-- Whether a reply actually asks anything of us, decided once when it lands.
-- NOTE the table name: the Prisma model is OutreachMessage, the physical
-- table is OutreachReply via @@map. Getting this wrong blocked every deploy
-- for three days on 18 August.
ALTER TABLE "OutreachReply" ADD COLUMN "replyNeeded" BOOLEAN;
ALTER TABLE "OutreachReply" ADD COLUMN "replyNote" TEXT;
ALTER TABLE "OutreachReply" ADD COLUMN "resumeAfter" TIMESTAMP(3);
