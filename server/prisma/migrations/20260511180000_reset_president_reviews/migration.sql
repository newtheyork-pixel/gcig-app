-- The review now uses a different question set (q1..q4 with new
-- semantics), so prior responses are no longer comparable. Wipe the
-- table so the new cycle starts clean. Schema is untouched.
DELETE FROM "PresidentReview";
