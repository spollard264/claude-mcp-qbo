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

export function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      const raw = fs.readFileSync(TOKENS_PATH, 'utf-8');
      tokenData = JSON.parse(raw);
      const client = getOAuthClient();
      client.setToken({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: 'bearer',
        expires_in: tokenData.expires_in || 3600,
        x_refresh_token_expires_in: tokenData.x_refresh_token_expires_in || 8726400,
        realmId: tokenData.realmId,
      });
      return true;
    }
  } catch (err) {
    console.error('Failed to load tokens:', err.message);
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
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));
  console.log('Tokens saved to tokens.json');
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
      client.setToken({
        access_token: newToken.access_token,
        refresh_token: newToken.refresh_token,
        token_type: 'bearer',
        expires_in: newToken.expires_in,
        x_refresh_token_expires_in: newToken.x_refresh_token_expires_in,
        realmId: tokenData.realmId,
      });
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

export function getRealmId() {
  return tokenData?.realmId;
}

export function getAccessToken() {
  return tokenData?.access_token;
}
