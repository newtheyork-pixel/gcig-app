-- Director of Research. Ranked above CIO and below President in
-- ROLE_RANK (middleware/auth.js) and inside EXECUTIVE_ROLES, because a
-- role that outranks one it cannot substitute for is an org chart the
-- permission gates disagree with.
--
-- Appended rather than inserted in hierarchy order: Postgres enum values
-- carry ordinals, and reordering them would rewrite every existing row's
-- stored value. Display order lives in ROLE_RANK, not in the enum.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'DirectorOfResearch';
