#!/usr/bin/env bash
# One-time host setup: installs SDKMAN (the agent installs specific JDKs /
# Maven / Gradle versions on demand at runtime) and seeds the most common
# toolchain so the first few builds don't all start with installs.
# No -u: sdkman-init.sh reads variables it doesn't define first
set -eo pipefail

SDKMAN_DIR="${SDKMAN_DIR:-$HOME/.sdkman}"

if [ ! -d "$SDKMAN_DIR" ]; then
  echo "==> Installing SDKMAN..."
  curl -s "https://get.sdkman.io" | bash
else
  echo "==> SDKMAN already installed."
fi

# Non-interactive mode so agent-driven "sdk install" never blocks on a prompt.
mkdir -p "$SDKMAN_DIR/etc"
if ! grep -q "sdkman_auto_answer=true" "$SDKMAN_DIR/etc/config" 2>/dev/null; then
  echo "sdkman_auto_answer=true" >> "$SDKMAN_DIR/etc/config"
fi

source "$SDKMAN_DIR/bin/sdkman-init.sh"

echo "==> Seeding common toolchain (JDK 8, 11, 17 + Maven)..."
# Not every vendor ships every major (e.g. SDKMAN has no Temurin 8),
# so prefer tem, then fall back through other reputable vendors.
for major in 8 11 17; do
  if ls "$SDKMAN_DIR/candidates/java/" 2>/dev/null | grep -q "^${major}\."; then
    echo "    java ${major}.x already installed"
    continue
  fi
  candidates=$(sdk list java | tr '|' '\n' | tr -d ' ' | grep -E "^${major}\.[0-9.]+" | grep -v '\.fx' | sort -u)
  id=""
  for vendor in tem zulu librca amzn kona; do
    id=$(echo "$candidates" | grep -- "-${vendor}\$" | head -1 || true)
    [ -n "$id" ] && break
  done
  if [ -n "$id" ]; then
    echo "    java $id"
    sdk install java "$id" || true
  else
    echo "    WARNING: no installable JDK found for major $major"
  fi
done

if [ ! -d "$SDKMAN_DIR/candidates/maven" ]; then
  sdk install maven || true
fi

echo "==> Done. Installed:"
ls "$SDKMAN_DIR/candidates/java" 2>/dev/null || true
ls "$SDKMAN_DIR/candidates/maven" 2>/dev/null || true
