CREATE TABLE "AppRelease" (
  "id"        SERIAL PRIMARY KEY,
  "version"   TEXT NOT NULL,
  "url"       TEXT NOT NULL,
  "sha256"    TEXT NOT NULL,
  "bytes"     INTEGER,
  "notes"     TEXT,
  "live"      BOOLEAN NOT NULL DEFAULT true,
  "mandatory" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AppRelease_version_key" ON "AppRelease"("version");
CREATE INDEX "AppRelease_live_createdAt_idx" ON "AppRelease"("live", "createdAt");
