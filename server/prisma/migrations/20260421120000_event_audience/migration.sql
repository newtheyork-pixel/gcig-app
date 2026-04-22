-- Tag events with an audience scope so the Calendar can filter "Advisory
-- Board only" meetings. Default is 'all' (visible to every member).
-- Extend with additional values later ('leadership', 'analysts', etc.)
-- without needing another migration.
ALTER TABLE "Event" ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'all';
