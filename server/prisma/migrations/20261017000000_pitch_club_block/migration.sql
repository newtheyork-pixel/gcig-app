-- Wednesday club block is a valid pitch-meeting period, alongside
-- first lunch, second lunch, and either lunch.
ALTER TYPE "LunchPeriod" ADD VALUE IF NOT EXISTS 'Club';
