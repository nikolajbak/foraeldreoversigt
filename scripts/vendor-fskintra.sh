#!/bin/sh
# Henter ForældreIntra-login og -parsere fra emilhorlyck/fskintra-mcp (MIT) på
# et fastlåst commit og lægger dem i supabase/functions/foraeldre-api/fskintra/.
#
# Gennemgået 2026-10-04: det eneste netværkskald er fetch() i auth/http.ts, og
# login-oplysningerne POSTes kun til skolens egen ForældreIntra-formular
# (UniLogin/emu.dk afvises). Keychain-lageret (child_process) tages ikke med.
#
# Skift aldrig COMMIT uden at gennemgå diff'en først.
set -eu
REPO=https://github.com/emilhorlyck/fskintra-mcp
COMMIT=c966c0c869fa2cf6417257a4d56ab14545349067

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/supabase/functions/foraeldre-api/fskintra"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" fetch -q --depth 1 "$REPO" "$COMMIT"
git -C "$TMP" checkout -q FETCH_HEAD
P="$TMP/packages"

rm -rf "$DEST"
mkdir -p "$DEST/auth" "$DEST/client/sections"
cp "$TMP/LICENSE" "$DEST/LICENSE"
echo "$REPO @ $COMMIT" > "$DEST/KILDE.txt"

for f in "$P"/fskintra-auth/src/*.ts; do
  case "$f" in *.test.ts|*/keychain-session-store.ts) continue ;; esac
  cp "$f" "$DEST/auth/"
done
for f in "$P"/fskintra-client/src/*.ts; do
  case "$f" in *.test.ts) continue ;; esac
  cp "$f" "$DEST/client/"
done
for f in "$P"/fskintra-client/src/sections/*.ts; do
  case "$f" in *.test.ts) continue ;; esac
  cp "$f" "$DEST/client/sections/"
done

# Workspace-importen peger på den lokale kopi; keychain-lageret er væk.
sed -i '' "s|'@fskintra-mcp/fskintra-auth'|'../auth/index.ts'|" "$DEST"/client/*.ts
sed -i '' "s|'@fskintra-mcp/fskintra-auth'|'../../auth/index.ts'|" "$DEST"/client/sections/*.ts
sed -i '' "/keychain-session-store/d" "$DEST/auth/index.ts"
# Edge-funktioner deployes uden import map, så npm-pakkerne skrives direkte.
find "$DEST" -name '*.ts' -exec sed -i '' \
  -e "s|from 'cheerio'|from 'npm:cheerio@^1.2.0'|" \
  -e "s|from 'tough-cookie'|from 'npm:tough-cookie@^6.0.2'|" \
  -e "s|from 'domhandler'|from 'npm:domhandler@^6.0.1'|" {} +
sed -i '' -e "s/^  defaultStore,$/  MemorySessionStore,/" \
  -e "s/options.store ?? defaultStore()/options.store ?? new MemorySessionStore()/" \
  "$DEST/client/client.ts"

if grep -rn "defaultStore\|keychain-session-store\|child_process" "$DEST"; then
  echo "Uventet rest af keychain-lageret" >&2; exit 1
fi
echo "ForældreIntra-kode lagt i $DEST"
