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
QB_ENVIRONMENT=production
PORT=3000
```

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
   - `QB_ENVIRONMENT` = `production`
5. Deploy — Railway will use the Dockerfile automatically
6. Visit `https://your-domain.up.railway.app/auth` to complete OAuth

**Note:** `tokens.json` is stored on the container filesystem. Railway persistent volumes or an external store is recommended for production to avoid re-auth on redeploys.

## Connect to Claude

In Claude.ai settings (or `claude_desktop_config.json`), add the MCP server:

```json
{
  "mcpServers": {
    "quickbooks": {
      "type": "streamable-http",
      "url": "https://your-domain.up.railway.app/mcp"
    }
  }
}
```

For local development:

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

## Token Lifecycle

- **Access tokens** expire every 60 minutes and auto-refresh
- **Refresh tokens** last 101 days — re-authenticate before they expire
- Tokens persist in `tokens.json` between server restarts
