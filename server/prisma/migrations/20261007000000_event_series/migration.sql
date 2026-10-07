-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" INTEGER,
ADD COLUMN     "seriesId" INTEGER;

-- CreateTable
CREATE TABLE "EventSeries" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startHour" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "location" TEXT,
    "description" TEXT,
    "startsOn" TEXT NOT NULL,
    "endsOn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSeries_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "EventSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Seed the Wednesday meeting that used to be a constant in
-- services/recurringMeetings.js: 1:50 PM New York, from the first real
-- meeting on April 15. Every existing occurrence joins it, so nothing
-- already on the calendar, and no attendance taken at it, changes.
--
-- Until the June 1 rebrand the same meeting was "GCIG Weekly Meeting",
-- and nothing renamed the rows already made. The old code looked up only
-- the current title, so it left those rows where they were and made a
-- new row for every Wednesday beside them. Both titles are this series.
-- Linking both lets the schedule fold each upcoming pair into one
-- meeting; a day that has passed keeps both rows and every mark on them.
INSERT INTO "EventSeries" ("title", "dayOfWeek", "startHour", "startMinute", "durationMinutes", "description", "startsOn", "updatedAt")
VALUES ('Griffin Fund Weekly Meeting', 3, 13, 50, 30, 'Weekly club meeting (1:50 – 2:20 PM)', '2026-04-15', CURRENT_TIMESTAMP);

UPDATE "Event"
SET "seriesId" = (SELECT "id" FROM "EventSeries" WHERE "title" = 'Griffin Fund Weekly Meeting' ORDER BY "id" LIMIT 1)
WHERE "recurring" = true AND "title" IN ('Griffin Fund Weekly Meeting', 'GCIG Weekly Meeting');
