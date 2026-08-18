-- Group projects into research campaigns. Null means ungrouped, which is the common case.
ALTER TABLE "ResearchProject" ADD COLUMN "folder" TEXT;
