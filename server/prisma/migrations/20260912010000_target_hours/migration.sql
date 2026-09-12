-- When a door is open, in its own local time.
--
-- The sample spans three time zones, and the two worst moments to ask a
-- salesperson for two minutes are the opening rush and the last half
-- hour before close. A call queue that cannot see the clock inside the
-- store sends people to both, and the refusal it earns looks exactly
-- like a refusal about the questions.
--
-- `hours` is JSON because a store that shuts for an hour at lunch, or
-- opens twice on a Sunday, is a shape a pair of columns cannot hold. It
-- is stored as the banner's own locator publishes it:
--   [{ "day": "Monday", "opens": "11:00", "closes": "19:00" }, …]
--
-- `timezone` is an IANA zone and is stored per door rather than derived
-- at read time, because deriving it from the state is exact for most of
-- them and wrong for the ones that straddle a boundary: El Paso is
-- Mountain while the rest of Texas is Central.
--
-- Additive: two nullable columns.

ALTER TABLE "ResearchTarget" ADD COLUMN     "hours" JSONB,
ADD COLUMN     "timezone" TEXT;
