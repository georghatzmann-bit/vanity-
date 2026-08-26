#!/usr/bin/env sh
# Run every *_test.lua in test/. Requires lua5.4 (or lua).
set -e
cd "$(dirname "$0")/.."

LUA=$(command -v lua5.4 || command -v lua5.3 || command -v lua) || {
    echo "no lua interpreter found (apt-get install lua5.4)" >&2
    exit 1
}

status=0
for t in test/*_test.lua; do
    echo "### $t"
    "$LUA" "$t" || status=1
    echo
done
exit $status
