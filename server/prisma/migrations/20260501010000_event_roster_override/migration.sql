-- Persistent per-event roster overrides for the super-admin × button and
-- "add member" picker. Without this, a removed default-audience member
-- comes right back on next page load because the roster is computed
-- from role; a manually-added user disappears unless an attendance row
-- happened to be written.
--
--   included = false → user is hidden from this event's roster
--   included = true  → user is shown even if not in the default audience
CREATE TABLE "EventRosterOverride" (
    "eventId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "included" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRosterOverride_pkey" PRIMARY KEY ("eventId", "userId")
);

ALTER TABLE "EventRosterOverride"
    ADD CONSTRAINT "EventRosterOverride_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "Event"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventRosterOverride"
    ADD CONSTRAINT "EventRosterOverride_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
