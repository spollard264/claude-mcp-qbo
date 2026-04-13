import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'crypto';
import { getOAuthClient, loadTokens, saveTokens, isAuthenticated, ensureValidToken } from './auth.js';
import { tools } from './tools.js';

const app = express();
app.use(express.json());

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', authenticated: isAuthenticated() });
});

// ── OAuth routes ──
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

// ── API key auth middleware for /mcp ──
function requireApiKey(req, res, next) {
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    // No key configured — allow all requests (dev mode)
    return next();
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
    res.status(401).json({ error: 'Unauthorized - valid API key required' });
    return;
  }
  next();
}

// ── MCP Server setup ──

// Track transports per session for cleanup
const transports = new Map();

function createMcpServer() {
  const server = new McpServer({
    name: 'quickbooks-online',
    version: '1.0.0',
  });

  // Register all tools
  for (const t of tools) {
    server.tool(
      t.name,
      t.description,
      t.inputSchema,
      async (args) => {
        try {
          // Ensure we have a valid token before any tool call
          await ensureValidToken();
          const result = await t.handler(args);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}

// Streamable HTTP endpoint for MCP
app.all('/mcp', requireApiKey, async (req, res) => {
  // Handle GET for SSE stream (session resumption)
  // Handle POST for JSON-RPC messages
  // Handle DELETE for session termination
  const sessionId = req.headers['mcp-session-id'];

  if (req.method === 'GET' || req.method === 'DELETE') {
    // For GET/DELETE, we need an existing session
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  // POST - could be new session (initialize) or existing session
  if (sessionId && transports.has(sessionId)) {
    // Existing session
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session - create transport and server
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
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

  // Store transport after connect so sessionId is set
  if (transport.sessionId) {
    transports.set(transport.sessionId, transport);
    console.log(`New MCP session: ${transport.sessionId}`);
  }

  await transport.handleRequest(req, res, req.body);
});

// ── Import OAuthClient scopes ──
import OAuthClient from 'intuit-oauth';

// ── Start server ──
const PORT = process.env.PORT || 3000;

// Load saved tokens on startup
if (loadTokens()) {
  console.log('Loaded saved tokens from tokens.json');
  // Try a token refresh on startup to validate
  ensureValidToken()
    .then(() => console.log('Token validated successfully'))
    .catch((err) => console.log('Saved token needs re-auth:', err.message));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`QBO MCP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`OAuth start:  http://localhost:${PORT}/auth`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
