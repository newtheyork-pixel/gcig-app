-- Sending outreach from the member's own mailbox, and reading replies back
-- in without anyone logging them by hand.

CREATE TABLE "GmailAccount" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "revokedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GmailAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GmailAccount_userId_key" ON "GmailAccount"("userId");
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The thread id is what makes the reply loop precise. Matching inbound mail
-- by sender address would attach a reply to the wrong draft as soon as
-- somebody is written to twice.
ALTER TABLE "OutreachDraft" ADD COLUMN "gmailThreadId" TEXT;
ALTER TABLE "OutreachDraft" ADD COLUMN "gmailMessageId" TEXT;
ALTER TABLE "OutreachDraft" ADD COLUMN "sentVia" TEXT;
CREATE UNIQUE INDEX "OutreachDraft_gmailMessageId_key" ON "OutreachDraft"("gmailMessageId");

-- Unique, so a sweep that runs twice cannot log the same reply twice.
-- "Did they answer" is the question the whole follow-up clock is built on.
ALTER TABLE "OutreachReply" ADD COLUMN "gmailMessageId" TEXT;
CREATE UNIQUE INDEX "OutreachReply_gmailMessageId_key" ON "OutreachReply"("gmailMessageId");

-- One mailbox, one member. Two accounts holding live credentials to the
-- same inbox is a state where neither disconnect removes the other.
CREATE UNIQUE INDEX "GmailAccount_address_key" ON "GmailAccount"("address");
