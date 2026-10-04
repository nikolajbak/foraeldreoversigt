#!/bin/sh
# Bygger foraeldre-api til én fil i dist/. Edge-funktionens indgang importerer
# den fra raw.githubusercontent.com på et fastlåst commit, så et deploy kun
# skal sende én linje. npm-pakker hentes af Supabase ved deploy.
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
deno bundle --external 'npm:*' --platform deno -o dist/foraeldre-api.js supabase/functions/foraeldre-api/index.ts
echo "Bygget dist/foraeldre-api.js ($(wc -c < dist/foraeldre-api.js) bytes)"
