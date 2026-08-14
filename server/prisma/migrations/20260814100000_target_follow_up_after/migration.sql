-- An explicit "do not chase before" date, read by a human out of the
-- out-of-office reply. followUp.js resets its clock to the day the
-- auto-reply ARRIVED, not the day the person said they were back, so a
-- reply saying "returning the 24th" produced a chase on the 21st.
-- Treated as a floor on the computed date, never a trigger.
ALTER TABLE "ResearchTarget" ADD COLUMN "followUpAfter" TIMESTAMP(3);
