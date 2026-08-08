#!/bin/bash
# Build a Griffin Terminal anyone can download and run.
#
# The ordinary build.sh signs ad-hoc, which is enough for the machine it
# was built on and nowhere else: copied to another Mac, an ad-hoc bundle
# is refused by Gatekeeper with a message about a damaged app, which is
# both alarming and untrue. This signs with a Developer ID and turns on
# the hardened runtime, which is the combination Apple will notarize.
#
# NOTARIZATION IS A SEPARATE, MANUAL STEP and it needs a credential this
# script deliberately does not hold. Run once, ever:
#
#   xcrun notarytool store-credentials griffin \
#     --apple-id <the Apple ID owning the Developer ID> \
#     --team-id PW2VT56789 \
#     --password <an app-specific password from appleid.apple.com>
#
# Then this script will find the profile and notarize automatically. Until
# it does, it still produces a signed zip — first launch shows a
# right-click-to-open prompt rather than a clean double click, which is a
# reasonable place to start and an unreasonable place to stay.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(cat VERSION 2>/dev/null || echo 0.0.0)"
BUILD="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
APP="build/Griffin Terminal.app"
OUT="dist"
ZIP="$OUT/GriffinTerminal-$VERSION.zip"

# The Developer ID, not the Development certificate. They are different
# things with confusingly similar names: Development signs for machines
# in your provisioning profile, Developer ID signs for everyone else.
SIGN_ID="${GRIFFIN_DIST_ID:-Developer ID Application: DOMINIQUE,CHRISTINE SCHULTE (PW2VT56789)}"

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  echo "!! No Developer ID Application certificate in the keychain."
  echo "   Without one this cannot produce a distributable build."
  exit 1
fi

echo "==> version $VERSION (build $BUILD)"

# Tests gate the release. Twice now a build was signed and notarized
# while the suite was red, and both times the failures were real enough
# to demand a diagnosis before publishing — the gate makes the pause
# automatic. The live smoke tests can flake when a server deploy is
# rolling out at the same moment; RELEASE_SKIP_TESTS=1 is the explicit
# escape for exactly that, so skipping stays a decision and not a habit.
if [ "${RELEASE_SKIP_TESTS:-0}" != "1" ]; then
  echo "==> swift test (RELEASE_SKIP_TESTS=1 to skip)"
  swift test
fi

./build.sh release

# Stamp the version INTO the bundle. The updater compares what is
# installed against what is published, and a bundle that always claims
# 0.1.0 would either update forever or never.
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$APP/Contents/Info.plist"

echo "==> signing for distribution"
# --options runtime is the hardened runtime, which notarization requires
# and which is the one flag people forget; the submission is accepted and
# then rejected minutes later with a message that does not name it.
# Timestamped, because a signature without one stops validating the day
# the certificate expires rather than the day it was revoked.
codesign --force --deep --timestamp --options runtime \
  --sign "$SIGN_ID" "$APP"
codesign --verify --deep --strict --verbose=1 "$APP"

mkdir -p "$OUT"
rm -f "$ZIP"
# ditto, not zip: the standard zip loses the symlinks and extended
# attributes inside a bundle, and the result is refused as damaged after
# a perfectly good signature.
ditto -c -k --keepParent "$APP" "$ZIP"

if xcrun notarytool history --keychain-profile griffin >/dev/null 2>&1; then
  echo "==> notarizing (this takes a few minutes)"
  xcrun notarytool submit "$ZIP" --keychain-profile griffin --wait
  # The staple goes on the .app, then the zip is rebuilt around it, so
  # the ticket travels with the download and works offline.
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  echo "==> notarized and stapled"
else
  echo "!! Not notarized: no 'griffin' notarytool profile."
  echo "   The zip is signed and will run, but the first launch needs a"
  echo "   right-click and Open. See the header of this script."
fi

SHA="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
SIZE="$(stat -f%z "$ZIP")"
echo
echo "==> $ZIP"
echo "    version  $VERSION"
echo "    sha256   $SHA"
echo "    bytes    $SIZE"
echo
echo "Publish it with:"
echo "  curl -X POST \$API/api/app/releases -H \"Authorization: Bearer \$TOKEN\" \\"
echo "    -H 'Content-Type: application/json' -d '{\"version\":\"$VERSION\",\"sha256\":\"$SHA\",\"bytes\":$SIZE,\"url\":\"<where you hosted the zip>\"}'"
