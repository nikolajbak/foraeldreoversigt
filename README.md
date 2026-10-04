# Forældreoversigt

PWA der samler Aula, ForældreIntra og Holdsport for egne børn ét sted, med
push-notifikationer om nyt.

- App (GitHub Pages): https://nikolajbak.github.io/foraeldreoversigt/
- Backend: edge-funktionen `foraeldre-api` og skemaet `foraeldre` i Supabase-
  projektet `gjycsqshkvkcupdnvgvf`. Skemaet er ikke eksponeret i API'et.
- Repoet indeholder kun kode — ingen data, adgangskoder eller navne.

ForældreIntra-delen i `supabase/functions/foraeldre-api/fskintra/` er hentet
fra [emilhorlyck/fskintra-mcp](https://github.com/emilhorlyck/fskintra-mcp)
(MIT, se LICENSE i mappen) med `scripts/vendor-fskintra.sh`.
