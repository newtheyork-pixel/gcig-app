-- Store channel checks by telephone: the dial log, and two columns that
-- make a target dialable.
--
-- CallAttempt exists because most dials fail. Ring forty doors and
-- eleven answer, four will talk, and the seven refusals are themselves a
-- finding: a banner whose staff are told not to discuss pricing has told
-- you something. Logging only the calls that produced a transcript, as
-- Interview rows, would delete the denominator and turn every read off
-- this work into "of the stores that felt like talking".
--
-- So the attempt is the unit of record and the Interview hangs off it,
-- nullable, for the minority of calls worth keeping tape from. The
-- unique constraint on interviewId is deliberate: one dial is one
-- interview, and a second upload against the same call is a mistake
-- rather than a second opinion.
--
-- `metadataSource` keeps two unlike facts apart. A duration the phone
-- recorded and a duration the app timed are different measurements, and
-- a column that renders them alike invites a precision nobody took.
--
-- `consentRegime` decides what happens to the audio. Under a one-party
-- reading the recording is lawful on the caller's own consent and is
-- kept, because a tape is what a contested claim gets walked back to.
-- Under an all-party reading we asked, they agreed to a conversation
-- being recorded for notes, and the file goes once the transcript
-- exists. The default is the strict one, and `unknown` is treated as
-- all-party wherever it is read: a jurisdiction nobody established is
-- not a licence.
--
-- ResearchTarget gains `phone` because a target that is a PLACE is
-- reached by ringing it, and `locationState` because the regime above
-- turns on where both ends of a call sit.
--
-- Additive: one new table, two nullable columns.

ALTER TABLE "ResearchTarget" ADD COLUMN     "locationState" TEXT,
ADD COLUMN     "phone" TEXT;
CREATE TABLE "CallAttempt" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "targetId" INTEGER,
    "ticker" TEXT,
    "dialedNumber" TEXT NOT NULL,
    "callerId" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "outcome" TEXT,
    "metadataSource" TEXT NOT NULL DEFAULT 'apptimer',
    "answered" BOOLEAN,
    "consentSpoken" BOOLEAN NOT NULL DEFAULT false,
    "consentNote" TEXT,
    "recorded" BOOLEAN NOT NULL DEFAULT false,
    "consentRegime" TEXT NOT NULL DEFAULT 'all-party',
    "audioRetained" BOOLEAN NOT NULL DEFAULT false,
    "interviewId" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CallAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CallAttempt_interviewId_key" ON "CallAttempt"("interviewId");
CREATE INDEX "CallAttempt_projectId_startedAt_idx" ON "CallAttempt"("projectId", "startedAt" DESC);
CREATE INDEX "CallAttempt_targetId_idx" ON "CallAttempt"("targetId");
CREATE INDEX "CallAttempt_outcome_idx" ON "CallAttempt"("outcome");
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "ResearchTarget"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE SET NULL ON UPDATE CASCADE;
