import OAuthClient from 'intuit-oauth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, '..', 'tokens.json');

let oauthClient = null;
let tokenData = null;

export function getOAuthClient() {
  if (!oauthClient) {
    oauthClient = new OAuthClient({
      clientId: process.env.QB_CLIENT_ID,
      clientSecret: process.env.QB_CLIENT_SECRET,
      environment: OAuthClient.environment.production,
      redirectUri: process.env.QB_REDIRECT_URI,
    });
  }
  return oauthClient;
}

// Apply tokenData to the intuit-oauth client
function applyTokenToClient(data) {
  const client = getOAuthClient();
  client.setToken({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: 'bearer',
    expires_in: data.expires_in || 3600,
    x_refresh_token_expires_in: data.x_refresh_token_expires_in || 8726400,
    realmId: data.realmId,
  });
}

export function loadTokens() {
  // Priority 1: Environment variables (survive Railway redeploys)
  if (process.env.QB_ACCESS_TOKEN && process.env.QB_REFRESH_TOKEN && process.env.QB_REALM_ID) {
    tokenData = {
      access_token: process.env.QB_ACCESS_TOKEN,
      refresh_token: process.env.QB_REFRESH_TOKEN,
      realmId: process.env.QB_REALM_ID,
      expires_in: 3600,
      x_refresh_token_expires_in: 8726400,
      created_at: parseInt(process.env.QB_TOKEN_CREATED_AT || '0', 10) || Date.now(),
    };
    applyTokenToClient(tokenData);
    console.log('Loaded tokens from environment variables');
    return true;
  }

  // Priority 2: File storage (local dev / container filesystem)
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      const raw = fs.readFileSync(TOKENS_PATH, 'utf-8');
      tokenData = JSON.parse(raw);
      applyTokenToClient(tokenData);
      console.log('Loaded tokens from tokens.json');
      return true;
    }
  } catch (err) {
    console.error('Failed to load tokens from file:', err.message);
  }

  return false;
}

export function saveTokens(token, realmId) {
  tokenData = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_in: token.expires_in,
    x_refresh_token_expires_in: token.x_refresh_token_expires_in,
    realmId: realmId || tokenData?.realmId,
    created_at: Date.now(),
  };

  // Update process.env so in-process reads stay current
  process.env.QB_ACCESS_TOKEN = tokenData.access_token;
  process.env.QB_REFRESH_TOKEN = tokenData.refresh_token;
  process.env.QB_REALM_ID = tokenData.realmId;
  process.env.QB_TOKEN_CREATED_AT = String(tokenData.created_at);

  // Also write to file (works on local dev, best-effort on Railway)
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));
    console.log('Tokens saved to tokens.json');
  } catch (err) {
    console.log('Could not write tokens.json (expected on ephemeral filesystem):', err.message);
  }

  console.log('Tokens updated in process.env (copy to Railway env vars via /save-tokens)');
}

export async function ensureValidToken() {
  const client = getOAuthClient();

  if (!tokenData || !tokenData.access_token) {
    throw new Error('Not authenticated. Visit /auth to connect QuickBooks.');
  }

  // Check if access token is expired (with 5-minute buffer)
  const tokenAge = Date.now() - (tokenData.created_at || 0);
  const expiresIn = (tokenData.expires_in || 3600) * 1000;

  if (tokenAge > expiresIn - 300000) {
    console.log('Access token expired, refreshing...');
    try {
      const authResponse = await client.refresh();
      const newToken = authResponse.getJson();
      saveTokens(newToken, tokenData.realmId);
      applyTokenToClient(tokenData);
      console.log('Token refreshed successfully');
    } catch (err) {
      tokenData = null;
      throw new Error(`Token refresh failed: ${err.message}. Visit /auth to re-authenticate.`);
    }
  }

  return {
    accessToken: tokenData.access_token,
    realmId: tokenData.realmId,
  };
}

export function isAuthenticated() {
  return !!(tokenData && tokenData.access_token && tokenData.realmId);
}

export function getTokenData() {
  return tokenData;
}

export function getRealmId() {
  return tokenData?.realmId;
}

export function getAccessToken() {
  return tokenData?.access_token;
}
