#!/usr/bin/env bash
#
# Ship the iPhone app to TestFlight.
#
# The README spent a page recording what works and why, and prose is not a
# thing you can run at eleven at night. This is that page, executable.
#
#   ios/release.sh            bump the build number, build, archive, upload
#   ios/release.sh --check    everything up to the archive, then stop
#
# The two hard-won facts it encodes:
#   1. The archive is UNSIGNED on purpose and signing happens at export.
#      Automatic signing during an archive reaches for a DEVELOPMENT profile,
#      which needs a registered device, and the team has none.
#   2. `destination: upload` in ExportOptions.plist, never `export`. With
#      export you get a valid .ipa and no way to hand it over: the archive
#      records no team, so Organizer refuses it with "No Team Found in
#      Archive" and there is no fallback.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
CHECK_ONLY="${1:-}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- the tree must be clean ------------------------------------------------
# The script bumps the build number, builds from the WORKING TREE, uploads,
# and then tells you to commit. On a dirty tree that ordering ships code that
# is not in git: the binary members receive contains uncommitted work, and the
# commit afterwards records a different thing than what went out. Refuse
# instead, because the alternative is a build nobody can reproduce.
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  die "Working tree is dirty. Commit or stash before releasing."
fi

# --- the build number ------------------------------------------------------
# Derived, never typed. App Store Connect rejects a duplicate outright, and
# the old arrangement — a string literal in generate_project.py that somebody
# had to remember — is the kind of step that is only ever discovered missing
# at the end of a release.
BUILD=$(git rev-list --count HEAD)
VERSION=$(cat ios/VERSION 2>/dev/null || echo "0.0.0")
echo "$BUILD" > ios/BUILD_NUMBER
say "Griffin Fund iOS $VERSION ($BUILD)"

# --- the project file ------------------------------------------------------
python3 ios/generate_project.py >/dev/null
if ! git diff --quiet -- ios/GriffinFund.xcodeproj/project.pbxproj; then
  echo "  project.pbxproj regenerated (build number bump)"
fi

# --- gates -----------------------------------------------------------------
# A simulator build is the cheapest proof the thing compiles at all, and it
# needs no signing identity, so it runs even on a machine that cannot ship.
say "Building for the simulator"
xcodebuild -project ios/GriffinFund.xcodeproj -target GriffinFund \
  -sdk iphonesimulator -configuration Debug \
  CODE_SIGNING_ALLOWED=NO SYMROOT="$ROOT/ios/build" build \
  >/tmp/gf-sim-build.log 2>&1 || { tail -40 /tmp/gf-sim-build.log; die "Simulator build failed"; }
echo "  ok"

if [ "$CHECK_ONLY" = "--check" ]; then
  say "Stopping before the archive (--check)."
  exit 0
fi

# --- archive, unsigned -----------------------------------------------------
say "Archiving (unsigned — signing happens at export)"
rm -rf /tmp/GF.xcarchive /tmp/GF-out
xcodebuild -project ios/GriffinFund.xcodeproj -scheme GriffinFund \
  -destination 'generic/platform=iOS' -configuration Release \
  -archivePath /tmp/GF.xcarchive archive \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  >/tmp/gf-archive.log 2>&1 || { tail -40 /tmp/gf-archive.log; die "Archive failed"; }
echo "  ok"

# --- sign and upload -------------------------------------------------------
say "Exporting to App Store Connect"
xcodebuild -exportArchive -archivePath /tmp/GF.xcarchive \
  -exportPath /tmp/GF-out -exportOptionsPlist ios/ExportOptions.plist \
  -allowProvisioningUpdates \
  >/tmp/gf-export.log 2>&1 || { tail -40 /tmp/gf-export.log; die "Export failed"; }

say "Uploaded $VERSION ($BUILD)."
cat <<EOF

  Commit the bump so the number that shipped is the number in the repo:

    git add ios/BUILD_NUMBER ios/GriffinFund.xcodeproj/project.pbxproj
    git commit -m "ios: $VERSION ($BUILD)"

  TestFlight builds expire 90 days after upload.
EOF
