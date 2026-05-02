-- Optional deck attached to events. Same shape as Pitch.slideshowUrl:
-- either an `onedrive:ITEM_ID` ref or an external URL (Google Slides, etc.).
-- Surfaced to every member as a "View slideshow" link in the event modal.
ALTER TABLE "Event" ADD COLUMN "slideshowUrl" TEXT;
