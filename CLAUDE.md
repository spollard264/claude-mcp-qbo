# CLAUDE.md — claude-mcp-qbo (Railway server)

Context for future Claude sessions working in this repo. Read this FIRST.

---

## What this is

A small Express server running on Railway that acts as the **single source of
truth for QuickBooks Online access** across the Harbinger ecosystem. It owns
the QBO OAuth refresh token and exposes two surfaces:

1. **`/mcp`** — Model Context Protocol server for Claude desktop clients.
2. **`/api/*`** — Authenticated JSON REST for the `harbinger-dashboard` Vercel
   app.

Both surfaces read the same underlying QBO connection, which means the refresh
token doesn't get rotated out from under either caller — the original problem
this server was created to solve.

**Production URL:** https://claude-mcp-qbo-production.up.railway.app

---

## Why this layer exists (the short version)

Before this server, the Vercel dashboard had its own Intuit OAuth client and
the MCP connector had its own. Both were using the same refresh token because
QBO only lets you have one active. Every time one side refreshed, the other
got an `invalid_grant` error. We consolidated into this Railway server so
there's only one place that touches Intuit OAuth.

---

## Stack

- **Express + Axios** under Node 20
- **Railway** for hosting. Deploys from `main` via Dockerfile.
- **Environment-variable persistence** of the refresh token — when the token
  rotates, we push the new value back to Railway via their API so the next
  cold boot has it.
- **Internal 60s cache** on `/api/*` endpoints (per-path + querystring).

---

## Repo layout

```
claude-mcp-qbo/
├── src/
│   ├── index.js          # Express app bootstrap; mounts MCP + /api
│   ├── auth.js           # Intuit OAuth — ensureValidToken(), refreshToken()
│   ├── mcp-auth.js       # MCP-side auth
│   ├── qbo-client.js     # Shared helper — used by MCP tool implementations
│   ├── dashboard-api.js  # /api/* routes for the Vercel dashboard
│   ├── tools.js          # MCP tools (list_customers, get_invoice, …)
│   └── railway.js        # Token persistence via Railway API
├── Dockerfile
├── railway.json
├── package.json
└── CLAUDE.md             # This file
```

---

## /api/* endpoints (used by the dashboard)

All require header `x-api-key: <DASHBOARD_API_KEY>`. CORS locked to the
dashboard origin(s) via `DASHBOARD_ALLOWED_ORIGINS`.

| Route | Purpose |
|---|---|
| `/api/accounts` | Chart of accounts (for AcctNum lookups) |
| `/api/reports/profit-and-loss` | P&L; used by `/api/expenses` on the dashboard |
| `/api/reports/transaction-list` | Transaction detail per account |
| `/api/reports/ar-aging` | Aged Receivables summary (powers AR Aging tab) |
| `/api/query` | Generic read-only SELECT passthrough |
| `/api/refresh` | Force token refresh |

---

## Environment variables

| Name | Purpose |
|---|---|
| `INTUIT_CLIENT_ID` | Intuit OAuth app client ID |
| `INTUIT_CLIENT_SECRET` | Intuit OAuth app secret |
| `INTUIT_REFRESH_TOKEN` | Current refresh token. Auto-rotated. |
| `INTUIT_REALM_ID` | QBO company ID |
| `DASHBOARD_API_KEY` | Must match `RAILWAY_API_KEY` on Vercel |
| `DASHBOARD_ALLOWED_ORIGINS` | CSV of allowed origins (add preview deploys) |
| `RAILWAY_API_TOKEN` | Used by `railway.js` to persist refreshed tokens |
| `MCP_AUTH_TOKEN` | For the `/mcp` surface (MCP client auth) |

---

## Deploy + branch policy

- **Deploys from `main`.** Railway watches this branch. Don't merge to
  long-lived side branches like `refactor/dashboard-json-endpoints` and expect
  deploys — that's how the April 2026 AR Aging endpoint got stuck "shipped to
  refactor but not live on production." Always merge to `main`.
- Feature branches → PR → squash-merge to `main` → Railway auto-redeploys.

---

## Common patterns when adding an endpoint

1. Write the handler in `src/dashboard-api.js` under `router.get(...)`.
2. Cache key pattern: `${routeName}:${JSON.stringify(params)}`.
3. Call QBO via `qboGet(path, params)` — it handles token refresh + errors.
4. Test locally with `node --check src/dashboard-api.js` or run the server
   and `curl -H "x-api-key: $KEY" http://localhost:PORT/api/...`.
5. PR → merge to `main` → wait ~60s → test against the prod URL.

---

## If something's broken

- **401 on `/api/*`** — unauth'd request (missing/wrong `x-api-key`), OR
  route doesn't exist on the deployed branch (middleware runs before
  routing, so 401 doesn't confirm the route is live).
- **"Cannot GET /api/..."** — route genuinely isn't registered on the live
  build. Check what's on `main` vs what's deployed.
- **`invalid_grant` from Intuit** — another client is also rotating the
  refresh token. The whole point of this server is to be the only one doing
  that. Check for a rogue OAuth client elsewhere.
- **Token age growing without refresh** — visit `/health` to see
  `tokenAgeMinutes` and `lastRefreshError`. `POST /api/refresh` to force a
  refresh.

---

## See also

- The Vercel consumer: `spollard264/harbinger-dashboard`
  - `api/_lib/qb.js` — the `qbApi()` wrapper that calls this server
- `/sessions/.../mnt/Claude MCP QBO/PROJECT_JOURNAL.md` — cross-repo context
