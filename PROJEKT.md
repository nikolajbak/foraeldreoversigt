# Forældreoversigt: projektbeskrivelse

Designet af Nikolaj Bak og bygget sammen med Claude Code som kodeassistent. Del af en portefølje på otte systemer
bygget fra september til november 2026.

- App (PWA), der samler Aula, ForældreIntra og Holdsport for egne børn ét sted og sender push ved nyt
- Integration til Aula via OAuth/PKCE med MitID-login i forælderens browser og automatisk fornyelse; Holdsport via det officielle API
- Synkroniserer automatisk dag og nat; første synkronisering er en tavs baseline, derefter push ved nyt eller ændret
- Data adskilt i eget databaseskema uden offentlig adgang; ingen data, adgangskoder eller navne i koden
- Teknik: JavaScript-PWA på GitHub Pages, Supabase edge-funktion (Deno/TypeScript), Postgres, pg_cron, web push

Teksten spejler afsnittet Projekter i `profil/fakta.md` i `nikolajbak/jobsoegning`, som er sandhedskilden til
ansøgninger. Ændres projektet væsentligt, så ret begge steder (status pr. 2026-11-02).
