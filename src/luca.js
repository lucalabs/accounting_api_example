// Minimal client for the Luca accounting OAuth2 provider.
//
// The flow, end to end:
//
//   1. Browser -> GET {host}/api/v1/oauth2/authorize
//                   ?client_id&response_type=code&redirect_uri&scope
//      Luca signs the user in, shows a company consent screen, and redirects
//      back to {redirect_uri}?code=...&scope=...
//   2. Server  -> POST {host}/api/v1/oauth2/token with grant_type=authorization_code
//      => { access_token (JWT), refresh_token, token_type, expires_in }
//   3. Server  -> POST {host}/api/v1/graphql with `Authorization: Bearer <access_token>`

import { logRequest, logResponse, logFailure } from "./logger.js";

export const SCOPE = "accounting";
export const DEFAULT_HOST = "https://go.lucaregnskap.no";

export const AUTHORIZE_PATH = "/api/v1/oauth2/authorize";
export const TOKEN_PATH = "/api/v1/oauth2/token";
export const GRAPHQL_PATH = "/api/v1/graphql";

// A small read-only query that only succeeds with a valid access token.
export const DEFAULT_QUERY = `{
  companies {
    nodes { id name organisationNumber }
  }
}`;

const TIMEOUT_MS = 30_000;

export class LucaError extends Error {}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|[\w-]+(\.[\w-]+)*\.localhost)(:\d+)?$/i;

export function normalizeHost(input) {
  const host = String(input ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!host) return DEFAULT_HOST;
  if (/^https?:\/\//i.test(host)) return host;

  // A local Luca instance almost always serves plain HTTP, so guessing https
  // there would produce a certificate error instead of a connection.
  return `${LOOPBACK.test(host) ? "http" : "https"}://${host}`;
}

// Step 1 — where we send the browser to ask the user for access.
//
// No `state` parameter: Luca's authorize endpoint does not accept one and does
// not echo it back on the callback, so there is nothing to correlate against.
export function authorizeUrl({ host, clientId, redirectUri }) {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
  });

  return `${normalizeHost(host)}${AUTHORIZE_PATH}?${query}`;
}

// Step 2 — swap the single-use code for an access token.
export function exchangeCode({ host, clientId, clientSecret, code, redirectUri }) {
  return tokenRequest(host, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

// Trade the refresh token for a fresh pair, with no user present.
export function refresh({ host, clientId, clientSecret, refreshToken }) {
  return tokenRequest(host, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

// Step 3 — prove the token actually opens the API.
//
// `variables` is optional: the query holds $placeholders and the variables
// object supplies their values, which is how you pass user input to Luca
// without pasting it into the query string.
export async function graphql({ host, accessToken, query, variables }) {
  const url = `${normalizeHost(host)}${GRAPHQL_PATH}`;
  const response = await request(url, {
    method: "POST",
    headers: headersFor(accessToken),
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });

  return { status: response.status, ms: response.ms, body: parseJson(response, url) };
}

export function headersFor(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function tokenRequest(host, params) {
  const url = `${normalizeHost(host)}${TOKEN_PATH}`;
  const response = await request(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const body = parseJson(response, url);

  // Luca answers 200 even when it rejects the grant, so the presence of an
  // access token — not the status code — is what says this worked.
  if (!body.access_token) throw new LucaError(tokenErrorMessage(body));

  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: body.token_type,
    expires_in: Number(body.expires_in) || 0, // arrives as a string
    grant_type: params.grant_type,
    obtained_at: new Date().toISOString(),
    refresh_count: 0,
  };
}

function tokenErrorMessage(body) {
  const detail =
    body.error_descriptions ?? body.errors_descriptions ?? body.errors ?? body.error;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? body);

  return `Token request failed: ${text}`;
}

async function request(url, options) {
  const started = Date.now();
  logRequest(options.method, url, options.body);

  let response;

  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const reason = error.cause?.code ?? error.name;
    logFailure(reason, Date.now() - started);

    throw new LucaError(unreachableMessage(url, reason));
  }

  const text = await response.text();
  const ms = Date.now() - started;
  logResponse(response.status, ms, text);

  return { status: response.status, text, ms };
}

// Node ships its own list of trusted certificate authorities and ignores the
// operating system's, so an instance behind a self-signed certificate fails
// here even when browsers and curl are perfectly happy with it. Saying so
// outright saves a long detour — "check the host setting" is the wrong advice.
const TLS_FAILURES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function unreachableMessage(url, reason) {
  if (TLS_FAILURES.has(reason)) {
    return (
      `Could not verify the TLS certificate at ${url} (${reason}). ` +
      "If this is a local instance, use its plain http:// address instead — " +
      "http://localhost:3000, for example."
    );
  }

  return `Could not reach Luca at ${url} (${reason}). Check the host setting.`;
}

function parseJson({ status, text }, url) {
  try {
    return JSON.parse(text);
  } catch {
    throw new LucaError(`Expected JSON from ${url}, got HTTP ${status}: ${truncate(text, 300)}`);
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function describeError(error) {
  return error instanceof LucaError ? error.message : `Unexpected error: ${error.message}`;
}
