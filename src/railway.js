/**
 * Railway API client for persisting env vars across deploys.
 *
 * Uses Railway's GraphQL API to upsert service variables with skipDeploys: true
 * so writing tokens doesn't trigger a redeploy loop.
 *
 * Requires: RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENVIRONMENT_ID
 * The last three are auto-injected by Railway at runtime.
 */

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

function getConfig() {
  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  if (!token || !projectId || !serviceId || !environmentId) {
    return null;
  }
  return { token, projectId, serviceId, environmentId };
}

/**
 * Upsert a single env var on the Railway service without triggering a redeploy.
 */
async function upsertVariable(config, name, value) {
  const query = `
    mutation variableUpsert($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }
  `;

  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: {
        input: {
          projectId: config.projectId,
          environmentId: config.environmentId,
          serviceId: config.serviceId,
          name,
          value,
          skipDeploys: true,
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Railway API HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Railway API error: ${json.errors[0].message}`);
  }
  return true;
}

/**
 * Persist QBO tokens to Railway env vars.
 * Returns { success: boolean, error?: string }
 */
export async function persistTokensToRailway(tokenData) {
  const config = getConfig();
  if (!config) {
    return {
      success: false,
      error: 'Railway API not configured (missing RAILWAY_API_TOKEN or Railway-injected IDs)',
    };
  }

  const vars = {
    QB_ACCESS_TOKEN: tokenData.access_token,
    QB_REFRESH_TOKEN: tokenData.refresh_token,
    QB_REALM_ID: tokenData.realmId,
    QB_TOKEN_CREATED_AT: String(tokenData.created_at),
  };

  const errors = [];
  for (const [name, value] of Object.entries(vars)) {
    try {
      await upsertVariable(config, name, value);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  if (errors.length > 0) {
    return { success: false, error: errors.join('; ') };
  }
  return { success: true };
}

/**
 * Check whether Railway API persistence is available.
 */
export function isRailwayConfigured() {
  return getConfig() !== null;
}
