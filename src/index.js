import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { randomUUID } from 'crypto';
import OAuthClient from 'intuit-oauth';
import { getOAuthClient, loadTokens, saveTokens, isAuthenticated, ensureValidToken, getTokenData } from './auth.js';
import { tools, toolMap } from './tools.js';
import {
  registerClient,
  validateAuthRequest,
  createAuthCode,
  exchangeCodeForToken,
  validateBearerToken,
  getServerUrl,
  buildProtectedResourceMetadata,
  buildAuthServerMetadata,
} from './mcp-auth.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', authenticated: isAuthenticated() });
});

// ── QuickBooks OAuth routes (for connecting to QBO) ──
app.get('/auth', (req, res) => {
  const client = getOAuthClient();
  const authUri = client.authorizeUri({
    scope: [
      OAuthClient.scopes.Accounting,
      OAuthClient.scopes.OpenId,
    ],
    state: randomUUID(),
  });
  res.redirect(authUri);
});

app.get('/callback', async (req, res) => {
  const client = getOAuthClient();
  try {
    const authResponse = await client.createToken(req.url);
    const token = authResponse.getJson();
    const realmId = req.query.realmId;
    saveTokens(token, realmId);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1>Connected to QuickBooks!</h1>
        <p>Company ID: ${realmId}</p>
        <p>You can close this window and start using the MCP server.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h1>Authentication Failed</h1>
        <p>${err.message}</p>
        <p><a href="/auth">Try again</a></p>
      </body></html>
    `);
  }
});

app.get('/auth-status', (req, res) => {
  res.json({
    authenticated: isAuthenticated(),
    message: isAuthenticated()
      ? 'Server is authenticated with QuickBooks Online.'
      : 'Not authenticated. Visit /auth to connect.',
  });
});

// ── Token display for Railway env var setup ──
app.get('/save-tokens', (req, res) => {
  const tokens = getTokenData();
  if (!tokens) {
    res.status(404).send(`
      <html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px">
        <h1>No Tokens Available</h1>
        <p>Complete the <a href="/auth">QuickBooks OAuth flow</a> first.</p>
      </body></html>
    `);
    return;
  }

  res.send(`
    <html>
    <head>
      <title>QBO Tokens — Copy to Railway</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #333; }
        h1 { font-size: 22px; }
        p { color: #666; font-size: 14px; }
        .var { margin: 16px 0; }
        .var label { display: block; font-weight: 600; font-size: 13px; color: #555; margin-bottom: 4px; }
        .var input { width: 100%; padding: 8px 10px; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; font-size: 13px; box-sizing: border-box; background: #f9f9f9; }
        .warn { background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 12px 16px; margin: 20px 0; font-size: 13px; }
        button { padding: 6px 14px; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; margin-top: 4px; }
        button:hover { background: #0052a3; }
        .ts { color: #999; font-size: 12px; margin-top: 4px; }
      </style>
    </head>
    <body>
      <h1>QuickBooks Token Values</h1>
      <p>Copy these into your Railway project's <strong>Variables</strong> tab to persist tokens across deploys.</p>
      <div class="warn">These are sensitive credentials. Do not share them or commit them to source control.</div>

      <div class="var">
        <label>QB_ACCESS_TOKEN</label>
        <input type="text" value="${tokens.access_token}" readonly onclick="this.select()">
        <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value)">Copy</button>
      </div>

      <div class="var">
        <label>QB_REFRESH_TOKEN</label>
        <input type="text" value="${tokens.refresh_token}" readonly onclick="this.select()">
        <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value)">Copy</button>
      </div>

      <div class="var">
        <label>QB_REALM_ID</label>
        <input type="text" value="${tokens.realmId}" readonly onclick="this.select()">
        <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value)">Copy</button>
      </div>

      <div class="var">
        <label>QB_TOKEN_CREATED_AT</label>
        <input type="text" value="${tokens.created_at}" readonly onclick="this.select()">
        <button onclick="navigator.clipboard.writeText(this.previousElementSibling.value)">Copy</button>
        <div class="ts">Created: ${new Date(tokens.created_at).toISOString()}</div>
      </div>

      <p style="margin-top:24px">After pasting into Railway, the next deploy will pick them up automatically. Tokens auto-refresh in memory — revisit this page after a refresh to get updated values.</p>
    </body>
    </html>
  `);
});

// ══════════════════════════════════════════════════════════════════
// MCP OAuth 2.1 Authorization Server (for Claude.ai to auth with us)
// ══════════════════════════════════════════════════════════════════

// ── Protected Resource Metadata (RFC 9728) ──
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  const serverUrl = getServerUrl(req);
  res.json(buildProtectedResourceMetadata(serverUrl));
});

app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  const serverUrl = getServerUrl(req);
  res.json(buildProtectedResourceMetadata(serverUrl));
});

// ── Authorization Server Metadata (RFC 8414) ──
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  const serverUrl = getServerUrl(req);
  res.json(buildAuthServerMetadata(serverUrl));
});

// ── Dynamic Client Registration (RFC 7591) ──
app.post('/register', (req, res) => {
  const result = registerClient(req.body || {});
  res.status(201).json(result);
});

// ── Authorization Endpoint ──
app.get('/authorize', (req, res) => {
  const validationError = validateAuthRequest(req.query);
  if (validationError) {
    res.status(400).json(validationError);
    return;
  }

  const { client_id, redirect_uri, code_challenge, state, scope } = req.query;

  // Show a simple login page where the user enters their MCP_API_KEY
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Authorize MCP Access</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 420px; width: 100%; }
        h1 { margin: 0 0 8px 0; font-size: 22px; }
        p { color: #666; margin: 0 0 24px 0; font-size: 14px; }
        label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 14px; }
        input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 15px; box-sizing: border-box; }
        input[type=password]:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 3px rgba(0,102,204,0.15); }
        button { width: 100%; padding: 12px; background: #0066cc; color: white; border: none; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 16px; }
        button:hover { background: #0052a3; }
        .error { color: #cc0000; font-size: 13px; margin-top: 8px; display: none; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Authorize MCP Access</h1>
        <p>Enter your server API key to grant Claude access to QuickBooks Online.</p>
        <form method="POST" action="/authorize">
          <input type="hidden" name="client_id" value="${client_id}">
          <input type="hidden" name="redirect_uri" value="${redirect_uri}">
          <input type="hidden" name="code_challenge" value="${code_challenge}">
          <input type="hidden" name="state" value="${state || ''}">
          <input type="hidden" name="scope" value="${scope || 'mcp'}">
          <label for="api_key">API Key</label>
          <input type="password" id="api_key" name="api_key" placeholder="Enter MCP_API_KEY" required autofocus>
          <div class="error" id="error"></div>
          <button type="submit">Authorize</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post('/authorize', (req, res) => {
  const { client_id, redirect_uri, code_challenge, state, scope, api_key } = req.body;

  // Validate the API key
  const expectedKey = process.env.MCP_API_KEY;
  if (!expectedKey) {
    res.status(500).send('MCP_API_KEY is not configured on the server.');
    return;
  }
  if (api_key !== expectedKey) {
    // Re-show the form with an error
    res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authorize MCP Access</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
          .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 420px; width: 100%; }
          h1 { margin: 0 0 8px 0; font-size: 22px; }
          p { color: #666; margin: 0 0 24px 0; font-size: 14px; }
          label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 14px; }
          input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 15px; box-sizing: border-box; }
          button { width: 100%; padding: 12px; background: #0066cc; color: white; border: none; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 16px; }
          .error { color: #cc0000; font-size: 13px; margin-top: 8px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Authorize MCP Access</h1>
          <p>Enter your server API key to grant Claude access to QuickBooks Online.</p>
          <form method="POST" action="/authorize">
            <input type="hidden" name="client_id" value="${client_id}">
            <input type="hidden" name="redirect_uri" value="${redirect_uri}">
            <input type="hidden" name="code_challenge" value="${code_challenge}">
            <input type="hidden" name="state" value="${state || ''}">
            <input type="hidden" name="scope" value="${scope || 'mcp'}">
            <label for="api_key">API Key</label>
            <input type="password" id="api_key" name="api_key" placeholder="Enter MCP_API_KEY" required autofocus>
            <div class="error">Invalid API key. Please try again.</div>
            <button type="submit">Authorize</button>
          </form>
        </div>
      </body>
      </html>
    `);
    return;
  }

  // Key is valid — generate auth code and redirect back
  const code = createAuthCode(client_id, redirect_uri, code_challenge, scope);
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  res.redirect(302, redirectUrl.toString());
});

// ── Token Endpoint ──
app.post('/token', (req, res) => {
  const result = exchangeCodeForToken(req.body);
  if (result.error) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

// ── MCP Bearer Token auth middleware ──
function requireAuth(req, res, next) {
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    // No key configured — allow all requests (dev mode)
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (validateBearerToken(authHeader)) {
    return next();
  }

  res.status(401).json({ error: 'Unauthorized - valid API key required' });
}

// ── MCP Server setup ──

// Track transports per session for cleanup
const transports = new Map();

function createMcpServer() {
  const server = new Server(
    { name: 'quickbooks-online', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // tools/list — return all tool definitions as plain JSON Schema
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // tools/call — dispatch to the matching tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Error: Unknown tool "${name}"` }],
        isError: true,
      };
    }
    try {
      await ensureValidToken();
      const result = await tool.handler(args || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Streamable HTTP endpoint for MCP
app.all('/mcp', requireAuth, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: 'Invalid or missing session ID' });
        return;
      }
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res);
      return;
    }

    // POST — existing session
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // POST — new session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
        console.log(`New MCP session: ${sessionId}`);
      },
    });

    const server = createMcpServer();

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        console.log(`Session ${sid} closed`);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP endpoint error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', message: err.message });
    }
  }
});

// ── Start server ──
const PORT = process.env.PORT || 3000;

// Load saved tokens on startup
if (loadTokens()) {
  ensureValidToken()
    .then(() => console.log('Token validated successfully'))
    .catch((err) => console.log('Saved token needs re-auth:', err.message));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QBO MCP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`QBO OAuth:    http://localhost:${PORT}/auth`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
