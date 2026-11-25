#!/usr/bin/env bash
set -euo pipefail

# FreeMyDisk macOS DMG packaging script
echo "Configuring FreeMyDisk Universal DMG..."

APP_NAME="FreeMyDisk"
VERSION="1.0.0"
DMG_NAME="FreeMyDisk-${VERSION}-universal.dmg"

# Ensure universal binary created via lipo
# lipo -create -output src-tauri/target/universal/FreeMyDisk \
#   src-tauri/target/aarch64-apple-darwin/release/FreeMyDisk \
#   src-tauri/target/x86_64-apple-darwin/release/FreeMyDisk

echo "Packaging DMG for ${APP_NAME} v${VERSION}..."
