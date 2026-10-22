# Forældreoversigt

PWA, der samler Aula, ForældreIntra og Holdsport for egne børn ét sted, med
push om nyt. Brugervejledning og kildeoplysninger: `README.md`.

## Overblik

| | |
|---|---|
| Repo | `nikolajbak/foraeldreoversigt` · lokalt `~/Foraeldreoversigt` · direkte på `main` |
| Kører på | GitHub Pages → https://nikolajbak.github.io/foraeldreoversigt/ · Supabase edge-funktion `foraeldre-api` + pg_cron |
| Data | Supabase `gjycsqshkvkcupdnvgvf` (»Vinted Automation«), skemaet `foraeldre` — projektet deles med vinted-udbakke, maerkedag og tesla_watch |
| Stack | Vanilla JS-klient (`app.js`, `index.html`, `sw.js`), ingen build · funktionen i Deno/TypeScript, bundlet med `deno bundle` |
| Betalte API'er | ingen |

## Kommandoer

```bash
python3 -m http.server          # klienten lokalt (se .claude/launch.json)
sh scripts/byg-api.sh           # → dist/foraeldre-api.js (kræver deno)
sh scripts/vendor-fskintra.sh   # opdatér den vendorerede ForældreIntra-kode (fast commit)
```

Der er ingen tests.

## Arkitektur

| Del | Filer |
|---|---|
| Klient: viser kun det, funktionen har hentet | `app.js`, `index.html`, `style.css`, `sw.js` |
| API, sync og push | `supabase/functions/foraeldre-api/` (`index.ts`, `sync.ts`, `push.ts`, `db.ts`) |
| Kilderne | `aula.ts`, `foraeldreintra.ts` + `fskintra/` (vendoreret, MIT), `holdsport.ts` |
| Skema og cron | `sql/001_foraeldre.sql`, `sql/002_cron.sql` |

Første synk pr. kilde er tavs (baseline); derefter push ved nyt eller ændret.

## Udrulning

- **Klienten:** push til `main` → GitHub Pages.
- **`foraeldre-api`:** Supabase CLI er ikke logget ind, så:
  1. `sh scripts/byg-api.sh` → `dist/foraeldre-api.js` (én fil, npm-pakker eksterne).
  2. Commit og push; notér commit-SHA.
  3. Supabase MCP `deploy_edge_function` (`verify_jwt: false`) med én `index.ts`,
     der kun importerer
     `https://raw.githubusercontent.com/nikolajbak/foraeldreoversigt/<SHA>/dist/foraeldre-api.js`.
     Altid en fast SHA, aldrig `main`.

## Data og hemmeligheder

- **Hold projekterne adskilt.** Alt herfra ligger i skemaet `foraeldre` og i
  funktioner og cron-job med `foraeldre`-navne. Skemaet er ikke eksponeret i
  PostgREST, og anon/authenticated har ingen rettigheder; funktionen taler
  direkte med Postgres via `SUPABASE_DB_URL`. Rør aldrig andre skemaer, og
  brug ikke den fælles vault.
- Tabeller: `config`, `credentials`, `children`, `items`, `source_status`,
  `push_subscriptions`, `notifications`. VAPID-nøgler og ventende Aula-login
  ligger i `foraeldre.config`.
- Adgang til funktionen: familiekode (`x-familiekode`) for appen,
  `x-cron-secret` (fra `foraeldre.config`) for pg_cron-jobbene
  `foraeldre-synk-dag`/`foraeldre-synk-nat`.
- Repoet indeholder ingen data, adgangskoder eller navne.

## Kilderne

- **Aula:** app-klientens OAuth/PKCE. MitID-loginet sker i forælderens browser
  (STIL blokerer servere); forælderen indsætter `app-private.aula.dk?code=…`.
  Serveren fornyer selv via login.aula.dk. Refresh-tokenet roterer — sync
  tager en lease-lås, så to kørsler aldrig fornyer samtidig.
- **ForældreIntra:** kun skolens eget forældrelogin.
- **Holdsport:** officiel API, basic auth, ét login pr. barn.

## Faldgruber

- **ForældreIntra via UniLogin/MitID virker ikke fra serveren** (testet
  2026-10-04): fra Supabase stopper `broker.unilogin.dk` ved STIL's bot-tjek
  (`security-check.stil.dk/NDBD`), før MitID nås.
- `.claude/` er gitignored her — regelfiler i `.claude/rules/` kommer ikke med
  i repoet.

## Konventioner

- Dansk i brugerfladen og i navne.
- Den vendorerede `fskintra/` rettes ikke i hånden; hent den igen med scriptet.
