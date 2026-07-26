-- Provenance for a claim: the general extractor, or the question-first
-- answer scan. Re-extraction deletes and rewrites the extractor's rows,
-- and without this it silently took the scan's rows with them.
ALTER TABLE "ResearchClaim" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'extract';

-- The Lindt sweep ran before this column existed, so its rows would
-- arrive labelled as the extractor's and be deleted by the next
-- re-extraction. Topic is the only provenance they carry: the scan
-- writes exactly 'answer' or 'answer (partial)', and the extractor
-- writes a subject phrase ("restock frequency", "shelf space") and never
-- either of those two strings.
UPDATE "ResearchClaim"
   SET "origin" = 'answer-scan'
 WHERE "topic" IN ('answer', 'answer (partial)');
