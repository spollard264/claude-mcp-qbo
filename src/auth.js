import OAuthClient from 'intuit-oauth';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { persistTokensToRailway, isRailwayConfigured } from './railway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, '..', 'tokens.json');

const QBO_BASE_URL = 'https://quickbooks.api.intuit.com/v3/company';

let oauthClient = null;
let tokenData = null;
let lastRefreshAt = null;      // ISO 8601 timestamp of last successful refresh
let lastRefreshError = null;   // last refresh failure message, cleared on success
let refreshInFlight = null;    // concurrency guard: single in-flight refresh promise

// ── OAuth client ──

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

// ── Observability helpers ──

function tokenHash(token) {
  if (!token || token.length < 6) return '(none)';
  return '...' + token.slice(-6);
}

function logRefresh(action, details) {
  const ts = new Date().toISOString();
  console.log(`[TOKEN ${action}] ${ts} | ${details}`);
}

// ── Token load (startup) ──

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
    logRefresh('LOAD', `Source=env_vars | realm=${tokenData.realmId} | access=${tokenHash(tokenData.access_token)} | refresh=${tokenHash(tokenData.refresh_token)} | age=${Math.round((Date.now() - tokenData.created_at) / 60000)}min`);
    return true;
  }

  // Priority 2: File storage (local dev)
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      const raw = fs.readFileSync(TOKENS_PATH, 'utf-8');
      tokenData = JSON.parse(raw);
      applyTokenToClient(tokenData);
      logRefresh('LOAD', `Source=tokens.json | realm=${tokenData.realmId} | access=${tokenHash(tokenData.access_token)} | refresh=${tokenHash(tokenData.refresh_token)}`);
      return true;
    }
  } catch (err) {
    logRefresh('LOAD_ERROR', `File load failed: ${err.message}`);
  }

  return false;
}

// ── Token save (all three tiers) ──

export async function saveTokens(token, realmId) {
  const oldAccess = tokenHash(tokenData?.access_token);
  const oldRefresh = tokenHash(tokenData?.refresh_token);

  tokenData = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_in: token.expires_in,
    x_refresh_token_expires_in: token.x_refresh_token_expires_in,
    realmId: realmId || tokenData?.realmId,
    created_at: Date.now(),
  };

  const newAccess = tokenHash(tokenData.access_token);
  const newRefresh = tokenHash(tokenData.refresh_token);

  // Tier 1: process.env (immediate, survives within this process)
  process.env.QB_ACCESS_TOKEN = tokenData.access_token;
  process.env.QB_REFRESH_TOKEN = tokenData.refresh_token;
  process.env.QB_REALM_ID = tokenData.realmId;
  process.env.QB_TOKEN_CREATED_AT = String(tokenData.created_at);

  // Tier 2: Railway API (durable, survives redeploys)
  let railwayOk = false;
  if (isRailwayConfigured()) {
    try {
      const result = await persistTokensToRailway(tokenData);
      railwayOk = result.success;
      if (!result.success) {
        logRefresh('RAILWAY_PERSIST_FAIL', result.error);
      }
    } catch (err) {
      logRefresh('RAILWAY_PERSIST_FAIL', `Uncaught: ${err.message}`);
    }
  }

  // Tier 3: File (best-effort, local dev fallback)
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));
  } catch {
    // expected on ephemeral filesystems
  }

  logRefresh('SAVE', `access=${oldAccess}->${newAccess} | refresh=${oldRefresh}->${newRefresh} | railway=${railwayOk ? 'OK' : 'SKIP'} | realm=${tokenData.realmId}`);
}

// ── Token refresh ──

export async function refreshToken() {
  // Concurrency guard: if a refresh is already in-flight, piggyback on it.
  // Without this, two simultaneous requests would both try to refresh;
  // the second would fail because Intuit already rotated the refresh token.
  if (refreshInFlight) {
    logRefresh('REFRESH_DEDUP', 'Waiting on in-flight refresh');
    return refreshInFlight;
  }

  refreshInFlight = _doRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function _doRefresh() {
  const client = getOAuthClient();

  if (!tokenData || !tokenData.refresh_token) {
    throw new Error('No refresh token available. Visit /auth to connect QuickBooks.');
  }

  const oldAccess = tokenHash(tokenData.access_token);
  const oldRefresh = tokenHash(tokenData.refresh_token);

  logRefresh('REFRESH_START', `access=${oldAccess} | refresh=${oldRefresh}`);

  try {
    const authResponse = await client.refresh();
    const newToken = authResponse.getJson();
    // newToken contains the ROTATED refresh_token from Intuit — this is
    // what saveTokens writes to process.env, Railway API, and tokens.json.
    // (line: saveTokens reads newToken.refresh_token, NOT the old tokenData)
    await saveTokens(newToken, tokenData.realmId);
    applyTokenToClient(tokenData);
    lastRefreshAt = new Date().toISOString();
    lastRefreshError = null;

    const rotated = oldRefresh !== tokenHash(tokenData.refresh_token);
    logRefresh('REFRESH_OK', `access=${tokenHash(tokenData.access_token)} | refresh=${tokenHash(tokenData.refresh_token)} | refresh_rotated=${rotated}`);
    return tokenData;
  } catch (err) {
    lastRefreshError = err.message;
    logRefresh('REFRESH_FAIL', err.message);
    throw new Error(`Token refresh failed: ${err.message}. Visit /auth to re-authenticate.`);
  }
}

export async function ensureValidToken() {
  if (!tokenData || !tokenData.access_token) {
    throw new Error('Not authenticated. Visit /auth to connect QuickBooks.');
  }

  // Check if access token is expired (with 5-minute buffer)
  const tokenAge = Date.now() - (tokenData.created_at || 0);
  const expiresIn = (tokenData.expires_in || 3600) * 1000;

  if (tokenAge > expiresIn - 300000) {
    await refreshToken();
  }

  return {
    accessToken: tokenData.access_token,
    realmId: tokenData.realmId,
  };
}

// ── Startup health check: load, refresh, verify ──

export async function startupHealthCheck() {
  const steps = { load: false, refresh: false, qboTest: false, error: null };

  // Step 1: Load tokens
  steps.load = loadTokens();
  if (!steps.load) {
    steps.error = 'No tokens found in env vars or tokens.json. Visit /auth to connect QuickBooks.';
    return steps;
  }

  // Step 2: Force a refresh to get a fresh access token and persist the rotated refresh token
  try {
    await refreshToken();
    steps.refresh = true;
  } catch (err) {
    steps.error = `Token refresh failed: ${err.message}`;
    return steps;
  }

  // Step 3: Test call to QBO
  try {
    const res = await axios.get(`${QBO_BASE_URL}/${tokenData.realmId}/companyinfo/${tokenData.realmId}`, {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Accept': 'application/json',
      },
    });
    if (res.status === 200) {
      steps.qboTest = true;
      const companyName = res.data?.CompanyInfo?.CompanyName || res.data?.QueryResponse?.CompanyInfo?.[0]?.CompanyName || 'OK';
      logRefresh('STARTUP_OK', `QBO test passed, company: ${companyName}`);
    }
  } catch (err) {
    const msg = err.response?.data?.Fault?.Error?.[0]?.Message || err.message;
    steps.error = `QBO API test failed: ${msg}`;
    logRefresh('STARTUP_QBO_FAIL', steps.error);
  }

  return steps;
}

// ── Accessors ──

export function isAuthenticated() {
  return !!(tokenData && tokenData.access_token && tokenData.realmId);
}

export function getTokenData() {
  return tokenData;
}

export function getTokenMeta() {
  if (!tokenData) return null;
  return {
    tokenAgeMinutes: Math.round((Date.now() - (tokenData.created_at || 0)) / 60000),
    lastRefresh: lastRefreshAt,
    lastRefreshError: lastRefreshError,
    realmId: tokenData.realmId,
    accessTokenTail: tokenHash(tokenData.access_token),
    refreshTokenTail: tokenHash(tokenData.refresh_token),
    railwayPersistence: isRailwayConfigured() ? 'configured' : 'not_configured',
  };
}

export function getRealmId() {
  return tokenData?.realmId;
}

export function getAccessToken() {
  return tokenData?.access_token;
}
