#!/bin/bash
# Assemble a double-clickable Griffin Terminal.app.
#
# SwiftPM builds a bare executable; macOS needs a bundle with an
# Info.plist before it can own a menu bar, a Dock icon, or a window.
# This wraps the one into the other.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-release}"
APP="build/Griffin Terminal.app"

# Universal: arm64 AND x86_64, so the app runs on Apple Silicon AND on
# Intel Macs. A single-arch (arm64) build simply will not launch on Intel
# — Rosetta only translates the other direction — which is how an Intel
# member ended up unable to open it.
ARCHS="--arch arm64 --arch x86_64"

echo "==> swift build ($CONFIG, universal)"
swift build -c "$CONFIG" $ARCHS

BIN="$(swift build -c "$CONFIG" $ARCHS --show-bin-path)/GriffinTerminal"
[ -f "$BIN" ] || { echo "no binary at $BIN"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/GriffinTerminal"
cp Info.plist "$APP/Contents/Info.plist"
cp assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null || true

# Ad-hoc signature. Enough for this machine and any Mac the .app is
# copied to by hand; a Developer ID identity would be needed to
# distribute it without the quarantine prompt.
# The File Provider extension.
#
# Built and signed here rather than by hand, because the app bundle is
# recreated on every build and an appex assembled once simply disappears
# — which cost two rounds of testing against a bundle with no Info.plist,
# where every failure looked like a signing problem.
#
# The combination that works, found by elimination: an Apple Development
# certificate, the App Group entitlement, and a valid Info.plist. Ad-hoc
# and Developer ID are both refused, and a missing plist is refused
# silently.
EXT="$APP/Contents/PlugIns/GriffinFileProvider.appex"
DEV_CERT="${GRIFFIN_SIGN_ID:-Apple Development: DOMINIQUE,CHRISTINE SCHULTE (2646H6TK2K)}"
GROUP="${GRIFFIN_APP_GROUP:-PW2VT56789.org.thegriffinfund.terminal}"
XCODE_SDK="$(ls -d /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk 2>/dev/null || true)"

# Off until the app is an Xcode project with a real extension target;
# a hand-assembled appex registers a domain nothing can serve.
if [ "${GRIFFIN_FILE_PROVIDER:-0}" = "1" ] && [ -n "$XCODE_SDK" ] && security find-identity -v -p codesigning 2>/dev/null | grep -q "$DEV_CERT"; then
  echo "==> file provider extension"
  mkdir -p "$EXT/Contents/MacOS"
  swiftc -sdk "$XCODE_SDK" -target arm64-apple-macos15.0 \
    -emit-executable -o "$EXT/Contents/MacOS/GriffinFileProvider" \
    Extension/FileProviderExtension.swift -framework FileProvider \
    -parse-as-library -Xlinker -e -Xlinker _NSExtensionMain 2>/dev/null \
    && sed "s|__GROUP__|$GROUP|g" Extension/Info.plist > "$EXT/Contents/Info.plist" \
    && cat > /tmp/griffin.entitlements <<ENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.application-groups</key><array><string>$GROUP</string></array>
  <key>com.apple.security.get-task-allow</key><true/>
  <!-- The extension is sandboxed and fetches from the API itself. Without
       network.client its URLSession never completes and Finder shows a
       folder that spins until it times out. -->
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.network.client</key><true/>
</dict></plist>
ENT
  # Two entitlement sets, deliberately.
  #
  # The EXTENSION is sandboxed and needs network access to reach the API
  # itself. The APP must not be sandboxed: it mounts a disk image, reads
  # Application Support and drives Finder, none of which survive a
  # sandbox. Signing both from one file killed the app on launch.
  cat > /tmp/griffin.app.entitlements <<ENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.application-groups</key><array><string>$GROUP</string></array>
  <key>com.apple.security.get-task-allow</key><true/>
</dict></plist>
ENT
  codesign --force --sign "$DEV_CERT" --entitlements /tmp/griffin.entitlements \
    --timestamp=none "$EXT" 2>/dev/null || echo "   (extension unsigned)"
  codesign --force --sign "$DEV_CERT" --entitlements /tmp/griffin.app.entitlements \
    --timestamp=none "$APP" 2>/dev/null || echo "   (app unsigned)"
else
  # No certificate: build the app without the extension rather than ship
  # one that cannot load. The volume still works; only the cloud icon and
  # download-on-demand are missing.
  echo "==> file provider off (set GRIFFIN_FILE_PROVIDER=1 to build it)"
  rm -rf "$EXT"
  codesign --force --deep --sign - "$APP" 2>/dev/null || echo "   (unsigned)"
fi

echo "==> $APP"
