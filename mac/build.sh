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

echo "==> swift build ($CONFIG)"
swift build -c "$CONFIG"

BIN="$(swift build -c "$CONFIG" --show-bin-path)/GriffinTerminal"
[ -f "$BIN" ] || { echo "no binary at $BIN"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/GriffinTerminal"
cp Info.plist "$APP/Contents/Info.plist"

# Ad-hoc signature. Enough for this machine and any Mac the .app is
# copied to by hand; a Developer ID identity would be needed to
# distribute it without the quarantine prompt.
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "   (unsigned)"

echo "==> $APP"
