-- The coverage group on the industries page was created under the
-- placeholder "pending". That string is the pod's name on pitches,
-- the calendar, and member profiles, so leaving it reads as a sector
-- that was never named. The column is unique, so the current name
-- identifies the row. If "Heath Care" is already taken, match nothing
-- rather than failing boot — a rename collision must not take the API
-- down for everyone.
UPDATE "Industry" AS i
SET "name" = 'Heath Care'
WHERE i."name" = 'pending'
  AND NOT EXISTS (
    SELECT 1 FROM "Industry" AS other WHERE other."name" = 'Heath Care'
  );
