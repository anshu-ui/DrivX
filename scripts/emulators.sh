#!/usr/bin/env bash
# Start the Firebase Emulator Suite, finding a suitable JDK if the system has none on PATH.
#
# The emulator's rule engines run on the JVM, but Homebrew installs openjdk as a keg-only
# formula, so `java` is often missing even when several JDKs are present. Rather than
# asking everyone to export JAVA_HOME by hand, probe the known locations and keep only
# ones that satisfy firebase-tools 15, which refuses anything below Java 21.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

# Print the major version of "$1/bin/java", or fail. Pre-9 releases report "1.8";
# normalize that to the two-digit form so the comparison below stays a single test.
java_major() {
  local line quoted major
  line="$("$1/bin/java" -version 2>&1 | head -1)" || return 1
  # The version is the first double-quoted field: openjdk version "21.0.13" 2026-10-20
  quoted="$(printf '%s' "$line" | awk -F'"' 'NF>1 {print $2}')"
  case "$quoted" in
    *[!0-9.]* | '') return 1 ;;
  esac
  major="${quoted%%.*}"
  if [ "$major" = "1" ]; then
    rest="${quoted#1.}"
    major="${rest%%.*}"
  fi
  case "$major" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$major"
}

# Set JAVA_HOME to the first candidate that reports at least 21.
pick_java() {
  local home major
  for home in "$@"; do
    [ -x "$home/bin/java" ] || continue
    if major="$(java_major "$home")" && [ "$major" -ge 21 ]; then
      export JAVA_HOME="$home"
      export PATH="$home/bin:$PATH"
      return 0
    fi
  done
  return 1
}

candidates=()

if [ -n "${JAVA_HOME:-}" ]; then
  candidates+=("$JAVA_HOME")
fi

system_java="$(command -v java 2>/dev/null || true)"
if [ -n "$system_java" ]; then
  # Resolve symlinks so /usr/bin/java -> a real JDK home, and skip the macOS stub,
  # which exists but cannot report a version.
  resolved="$(readlink -f "$system_java" 2>/dev/null || printf '%s' "$system_java")"
  candidates+=("$(dirname "$(dirname "$resolved")")")
fi

for prefix in /opt/homebrew/opt /usr/local/opt; do
  for formula in openjdk@21 openjdk; do
    candidates+=("$prefix/$formula/libexec/openjdk.jdk/Contents/Home")
  done
done

if command -v brew >/dev/null 2>&1; then
  for formula in openjdk@21 openjdk; do
    prefix="$(brew --prefix "$formula" 2>/dev/null || true)"
    [ -n "$prefix" ] && candidates+=("$prefix/libexec/openjdk.jdk/Contents/Home")
  done
fi

# Bash 3.2 (the macOS default) rejects expanding an empty array under `set -u`.
if [ "${#candidates[@]}" -eq 0 ] || ! pick_java "${candidates[@]}"; then
  echo "The Firebase emulator needs a JDK, and firebase-tools 15 refuses anything below Java 21." >&2
  echo "Install one:  brew install openjdk@21" >&2
  exit 1
fi

echo "Using $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"

# The Functions emulator loads functions/lib/index.js (its package.json "main"), so the
# TypeScript has to be compiled before the suite starts. @drivx/domain is resolved into
# that output, so build the domain package first.
echo "Building @drivx/domain and @drivx/functions for the Functions emulator…"
npm run build --prefix "$root" --workspace @drivx/domain --if-present
npm run build --prefix "$root" --workspace @drivx/functions --if-present

cd "$root"
exec npx firebase emulators:start --import ./.firebase/seed --export-on-exit "$@"
