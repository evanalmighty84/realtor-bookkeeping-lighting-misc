# Realtor + Outdoor Lighting + Bookkeeping Railway Scraper

This Railway repo runs:

- Realtor / FSBO: `For Sale & Free` → search `by owner` → `Categories` → `Home sales`
- Outdoor lighting: normal Posts searches for `lights` and `outdoor lighting`, 15 miles, Today
- Bookkeeping: normal Posts searches for `bookkeeper`, `bookkeeping`, `accountant`, `quickbooks`, `tax help`, and `payroll help`, 50 miles, Today

## Railway startup chain

```text
railway-entrypoint.sh
  -> starts / validates Multilogin launcher
  -> checkCoreDownload.js
       -> starts Multilogin profile
       -> waits for the browser/core
       -> passes MULTILOGIN_PORT to runRailway.js
            -> resolves webSocketDebuggerUrl
            -> launches index.js with MULTILOGIN_WS
```

Mount the persistent Railway volume at:

```text
/root/mlx
```

Set `PROFILE_ID` plus either Multilogin email/password or a Multilogin token.

The current `db/db.js` uses the same DB_* environment overrides and test fallback values as the existing scraper service.

## Main files

```text
index.js
checkCoreDownload.js
runRailway.js
railway-entrypoint.sh
Dockerfile
railway.json
package.json
normalizeCity.js
db/db.js
sql/001_special_search_learning.sql
```

## Learning

The service writes:

- `special_search_runs`
- `special_search_term_runs`
- `special_search_results`

`special_search_term_runs` records zero-result searches too, so bookkeeping terms remain visible in learning reports even on days with no matches.
