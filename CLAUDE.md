# Forældreoversigt

PWA på GitHub Pages (https://nikolajbak.github.io/foraeldreoversigt/, repo
`nikolajbak/foraeldreoversigt`) + edge-funktionen `foraeldre-api` og skemaet
`foraeldre` i Supabase-projektet `gjycsqshkvkcupdnvgvf` ("Vinted Automation").

## Hold projekterne adskilt

Projektet deles med maerkedag, tesla_watch og Vinted-appen. Alt herfra ligger i
skemaet `foraeldre` og funktioner/cron-job med `foraeldre`-navne. Skemaet er
ikke eksponeret i PostgREST, og anon/authenticated har ingen rettigheder;
funktionen taler direkte med Postgres via `SUPABASE_DB_URL`. Rør aldrig andre
skemaer, og brug ikke den fælles vault.

## Deploy af foraeldre-api

Supabase CLI er ikke logget ind. Deploy sker derfor sådan:

1. `sh scripts/byg-api.sh` → `dist/foraeldre-api.js` (én fil, npm-pakker eksterne).
2. Commit og push; notér commit-SHA.
3. Deploy via Supabase MCP (`deploy_edge_function`, `verify_jwt: false`) med én
   `index.ts`, der kun importerer
   `https://raw.githubusercontent.com/nikolajbak/foraeldreoversigt/<SHA>/dist/foraeldre-api.js`.
   Brug altid en fast SHA, aldrig `main`.

Funktionen har egen adgangskontrol: familiekode (`x-familiekode`) for appen,
`x-cron-secret` (fra `foraeldre.config`) for pg_cron-jobbene
`foraeldre-synk-dag`/`foraeldre-synk-nat`.

## Kilder

- **Aula:** app-klientens OAuth/PKCE. MitID-loginet sker i forælderens browser
  (STIL blokerer servere); forælderen indsætter `app-private.aula.dk?code=…`.
  Serveren fornyer selv via login.aula.dk. Refresh-tokenet roterer – sync tager
  en lease-lås, så to kørsler aldrig fornyer samtidig.
- **ForældreIntra:** vendoreret fra fskintra-mcp med `scripts/vendor-fskintra.sh`
  (fast commit). Kun skolens eget forældrelogin, ikke UniLogin/MitID: testet
  2026-10-04 – fra Supabase stopper `broker.unilogin.dk` ved STIL's bot-tjek
  (`security-check.stil.dk/NDBD`), før MitID nås.
- **Holdsport:** officiel API, basic auth, ét login pr. barn.

Første synk pr. kilde er tavs (baseline); derefter push ved nyt/ændret.
