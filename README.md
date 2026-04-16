# QuickBooks Online MCP Server

A Model Context Protocol (MCP) server that gives Claude full read/write access to QuickBooks Online. Supports invoices, customers, payments, vendors, bills, reports, and raw QBO queries.

## Setup

### 1. Create a QuickBooks App

1. Go to [Intuit Developer Dashboard](https://developer.intuit.com/app/developer/dashboard)
2. Create a new app (select "QuickBooks Online and Payments")
3. Under **Keys & credentials**, copy your **Client ID** and **Client Secret**
4. Add your redirect URI: `https://your-railway-domain.up.railway.app/callback` (or `http://localhost:3000/callback` for local dev)

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in:

```
QB_CLIENT_ID=your_client_id
QB_CLIENT_SECRET=your_client_secret
QB_REDIRECT_URI=http://localhost:3000/callback
MCP_API_KEY=your-strong-api-key-here
PORT=3000
```

Generate a strong API key:

```bash
node -e "console.log(crypto.randomUUID()+'-'+crypto.randomUUID())"
```

The `MCP_API_KEY` protects the `/mcp` endpoint. It is used as the shared secret during the OAuth authorization flow that Claude.ai performs automatically. If omitted, the `/mcp` endpoint is open (useful for local dev only).

### 3. Install and Run

```bash
npm install
npm start
```

### 4. Authenticate with QuickBooks

1. Open `http://localhost:3000/auth` in your browser
2. Sign in with your QuickBooks account and authorize the app
3. You'll be redirected back with a success message
4. Tokens are saved to `tokens.json` and auto-refresh every 60 minutes

Check status: `http://localhost:3000/auth-status`

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo
4. Add environment variables in Railway dashboard:
   - `QB_CLIENT_ID`
   - `QB_CLIENT_SECRET`
   - `QB_REDIRECT_URI` (set to `https://your-domain.up.railway.app/callback`)
   - `MCP_API_KEY` (generate a strong key — share it with your team)
5. Deploy — Railway will use the Dockerfile automatically
6. Visit `https://your-domain.up.railway.app/auth` to complete OAuth

**Note:** `tokens.json` is stored on the container filesystem. Railway persistent volumes or an external store is recommended for production to avoid re-auth on redeploys.

## Connect to Claude

### Claude.ai (Web)

Add your MCP server URL in Claude.ai's MCP settings:

```
https://your-domain.up.railway.app/mcp
```

When you connect, Claude.ai will automatically:
1. Discover the OAuth endpoints via `/.well-known/oauth-authorization-server`
2. Register a client via `POST /register`
3. Open a browser window to `/authorize` where you enter your `MCP_API_KEY`
4. Exchange the authorization code for an access token
5. Use the token for all subsequent `/mcp` requests

Each team member goes through this flow once. They all enter the same `MCP_API_KEY` value.

### Claude Desktop / Claude Code

In `claude_desktop_config.json`, add:

```json
{
  "mcpServers": {
    "quickbooks": {
      "type": "streamable-http",
      "url": "https://your-domain.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

Claude Desktop and Claude Code support passing the key directly via headers, bypassing the OAuth flow.

### Local Development

If `MCP_API_KEY` is not set in `.env`, no auth is required:

```json
{
  "mcpServers": {
    "quickbooks": {
      "type": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Available Tools

### Invoices
- `get_invoice` - Get invoice by ID
- `list_invoices` - List with filters (customer, date range, status)
- `create_invoice` - Create new invoice
- `update_invoice` - Update existing invoice
- `send_invoice` - Email an invoice
- `void_invoice` - Void an invoice

### Customers
- `get_customer` - Get customer by ID
- `list_customers` - Search by name/email
- `create_customer` - Create new customer
- `update_customer` - Update existing customer

### Payments
- `get_payment` - Get payment by ID
- `list_payments` - List with filters (customer, date range)
- `create_payment` - Record a payment
- `list_deposits` - List bank deposits

### Vendors
- `get_vendor` - Get vendor by ID
- `list_vendors` - Search vendors
- `create_vendor` - Create new vendor
- `update_vendor` - Update existing vendor

### Bills
- `get_bill` - Get bill by ID
- `list_bills` - List with filters (vendor, status, due date)
- `create_bill` - Create new bill
- `update_bill` - Update existing bill
- `pay_bill` - Pay a bill

### Reports
- `get_profit_and_loss` - P&L with date range
- `get_balance_sheet` - Balance sheet with date range
- `get_accounts_receivable_aging` - AR aging summary
- `get_accounts_payable_aging` - AP aging summary
- `get_cash_flow` - Cash flow statement

### General
- `get_company_info` - Company details
- `list_accounts` - Chart of accounts
- `query_qbo` - Raw QBO query for anything else

## Multi-User Support

This server supports concurrent requests from multiple Claude users (2-5 people). All users share the same QuickBooks connection. Each MCP session gets its own transport instance for safe concurrent operation.

## Token Lifecycle & Persistence

QBO tokens have two components:
- **Access token** — expires every 60 minutes, auto-refreshes
- **Refresh token** — valid for 100 days, **rotates on each refresh** (the old one is immediately invalidated)

Because the refresh token rotates, it's critical that every refresh persists the new token durably. Otherwise a container restart loads the old (now-invalid) refresh token and the server is locked out.

### How persistence works

On every token refresh, the server writes the new tokens to three tiers:

1. **`process.env`** — immediate, survives within the running process
2. **Railway API** — durable, writes `QB_ACCESS_TOKEN`, `QB_REFRESH_TOKEN`, `QB_REALM_ID`, `QB_TOKEN_CREATED_AT` back to Railway env vars via the GraphQL API (requires `RAILWAY_API_TOKEN`)
3. **`tokens.json`** — best-effort file write, works for local dev

### Railway API setup

1. Create an API token at [railway.com/account/tokens](https://railway.com/account/tokens)
2. Add `RAILWAY_API_TOKEN` to your Railway service's env vars
3. `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID` are auto-injected by Railway

With this configured, every token refresh automatically updates the Railway env vars. No manual copy-paste needed.

### Startup health check

On boot, the server:
1. Loads tokens from env vars (or `tokens.json` fallback)
2. Forces an immediate token refresh (gets a fresh access token, persists the rotated refresh token)
3. Makes a test call to `GET /companyinfo/{realmId}` to verify the QBO connection works
4. Logs a clear error if any step fails

Check `/health` for current status:
```json
{
  "status": "ok",
  "authenticated": true,
  "tokenAgeMinutes": 3,
  "lastRefresh": "2026-04-16T12:00:00.000Z",
  "lastRefreshError": null,
  "railwayPersistence": "configured"
}
```

## Troubleshooting Runbook

### Server goes unauthenticated

1. **Try `/refresh-now` first:**
   ```bash
   curl -X POST https://your-domain.up.railway.app/refresh-now \
     -H "Authorization: Bearer YOUR_MCP_API_KEY"
   ```
   If this returns `"success": true`, you're back online — the token was refreshed and persisted.

2. **If `/refresh-now` fails** with a token error, the refresh token has been invalidated (e.g., by another app using the same QBO OAuth credentials). Re-run the full OAuth flow:
   - Visit `https://your-domain.up.railway.app/auth`
   - Authorize with QuickBooks
   - The new tokens are automatically persisted to Railway env vars

3. **Check `/health`** to confirm: `"authenticated": true` and `"railwayPersistence": "configured"`.

### Shared QBO OAuth app (e.g., Vercel dashboard)

If another service (like a Vercel dashboard) uses the **same QBO OAuth app (same Client ID)**, their refresh tokens will conflict. When either side refreshes, it rotates the refresh token and invalidates the other's copy.

**Options:**
- **Separate OAuth apps** (recommended): Create a second app in the [Intuit Developer Dashboard](https://developer.intuit.com/app/developer/dashboard) so each service has its own token pair.
- **Single source of truth**: Have only the MCP server do refreshes, and have the other service read tokens from the Railway env vars via Railway's API.
