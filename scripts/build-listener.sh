#!/bin/bash
# Builds the native "Hey Turbo" speech listener into a signed .app bundle so
# macOS attributes the mic/speech permission prompts correctly and remembers them.
set -e
cd "$(dirname "$0")/../helpers"

echo "Compiling turbo-listen.swift…"
# Embed Info.plist into the binary's __TEXT,__info_plist section so macOS reads
# the mic/speech usage descriptions even when the bare binary is exec'd directly
# (otherwise it SIGABRTs on first mic access).
swiftc -O turbo-listen.swift -o turbo-listen \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist

# Also wrap it in a .app (some macOS versions prefer a real bundle for TCC).
APP="TurboListen.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp turbo-listen "$APP/Contents/MacOS/turbo-listen"
cp Info.plist "$APP/Contents/Info.plist"

# Ad-hoc sign (stable identity so TCC remembers the grant across rebuilds).
codesign --force --sign - "$APP/Contents/MacOS/turbo-listen"
codesign --force --deep --sign - "$APP"

echo "Built $(pwd)/$APP"
