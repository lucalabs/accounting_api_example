// Minimal client for the Luca accounting API — OAuth 2.1, authorization code
// with PKCE.
//
// The flow, end to end:
//
//   0. Server  -> GET {host}/.well-known/oauth-authorization-server
//      Luca is served on many hosts, and each one names its own endpoints, so
//      the endpoints below are read rather than assumed. See src/discovery.js.
//   1. Browser -> GET {authorization_endpoint}
//                   ?client_id&response_type=code&redirect_uri&scope
//                    &state&code_challenge&code_challenge_method=S256
//      Luca signs the user in, asks which of their companies this integration
//      may reach, and redirects back to {redirect_uri}?code=…&state=…&iss=…
//   2. Server  -> POST {token_endpoint} with grant_type=authorization_code and
//      the code_verifier that matches the challenge from step 1
//      => { access_token (opaque), refresh_token, token_type, scope, expires_in }
//   3. Server  -> POST {host}/api/v1/graphql with `Authorization: Bearer <access_token>`
//      Every query and mutation names the company it is about — see src/schema.js.

import { createHash, randomBytes } from "node:crypto";

import { logRequest, logResponse, logFailure } from "./logger.js";

// `accounting.read` is the authorization server's default scope, so a token
// always carries it; `accounting.write` has to be asked for, and without it
// every mutation is refused.
export const SCOPES = { read: "accounting.read", write: "accounting.write" };
export const DEFAULT_SCOPE = SCOPES.read;

export const DEFAULT_HOST = "https://go.lucaregnskap.no";

// The one path still written down here. It is the fallback for the resource
// named in /.well-known/oauth-protected-resource, which is where it should
// come from.
export const GRAPHQL_PATH = "/api/v1/graphql";

// A small read-only query that does two jobs: it proves the access token
// opens the API, and it answers the question every other field then asks —
// which companies may this token name in `companyId`?
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

// Scopes arrive as one space-separated string, in no particular order.
export function grants(granted, wanted) {
  return String(granted ?? "").split(/\s+/).includes(wanted);
}

// PKCE (RFC 7636). The verifier is a secret this server keeps; only its hash
// travels through the browser, because the front channel is visible to the
// user, their extensions and every redirect in between. Whoever intercepts the
// authorization code still cannot spend it without the verifier.
//
// 32 random bytes base64url-encode to 43 characters, the shortest length the
// spec allows and plenty of entropy.
export function createPkce() {
  const verifier = randomBytes(32).toString("base64url");

  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    method: "S256",
  };
}

// Ties a callback back to the request that started it. Luca echoes it back
// unchanged, and a mismatch means the callback did not come from us.
export function randomState() {
  return randomBytes(16).toString("base64url");
}

// Step 1 — where we send the browser to ask the user for access.
//
// `endpoint` is the authorization_endpoint read from discovery, not a path
// glued onto a host, so a Luca instance that moves it keeps working.
export function authorizeUrl({
  endpoint,
  clientId,
  redirectUri,
  scope,
  state,
  codeChallenge,
  organisationNumber,
  locale,
}) {
  // Built through URL rather than by string concatenation so a discovered
  // endpoint that already carries a query string keeps it.
  const url = new URL(endpoint);

  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  // Optional. `organisation_number` pins the consent screen to one company
  // instead of listing all of the user's; `locale` picks nb or en.
  if (organisationNumber) url.searchParams.set("organisation_number", organisationNumber);
  if (locale) url.searchParams.set("locale", locale);

  return url.toString();
}

// Step 2 — swap the single-use code for tokens, proving with the verifier that
// this is the same client that started the flow.
export function exchangeCode({
  tokenEndpoint,
  clientId,
  clientSecret,
  code,
  redirectUri,
  codeVerifier,
}) {
  return tokenRequest(tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });
}

// Trade the refresh token for a fresh pair, with no user present.
export function refresh({ tokenEndpoint, clientId, clientSecret, refreshToken }) {
  return tokenRequest(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

// RFC 7009. Answers 200 with an empty body whether or not the token existed,
// so there is nothing to parse and nothing to learn from the response.
export async function revokeToken({
  revocationEndpoint,
  clientId,
  clientSecret,
  token,
  tokenTypeHint,
}) {
  const { status, ms } = await request(revocationEndpoint, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: formFor({
      token,
      token_type_hint: tokenTypeHint,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (status >= 400) throw new LucaError(`Revocation was refused (HTTP ${status}).`);

  return { status, ms };
}

// RFC 8414 — the authorization server's own description of itself.
export async function authorizationServerMetadata(url) {
  const response = await request(url, { method: "GET", headers: { Accept: "application/json" } });

  if (response.status >= 400) {
    throw new LucaError(`No metadata document at ${url} (HTTP ${response.status}).`);
  }

  return parseJson(response, url);
}

// RFC 9728 — the resource's description of itself, naming the authorization
// server that guards it. Reachable without knowing the host up front: a 401
// from the API points at this document. See parseChallenge.
export async function protectedResourceMetadata(url) {
  const response = await request(url, { method: "GET", headers: { Accept: "application/json" } });

  if (response.status >= 400) {
    throw new LucaError(`No resource metadata at ${url} (HTTP ${response.status}).`);
  }

  return parseJson(response, url);
}

// `WWW-Authenticate: Bearer resource_metadata="https://…"` — the parameter
// value is a quoted string, so the quotes are syntax rather than content.
export function parseChallenge(header) {
  if (!header || !/^Bearer\b/i.test(header)) return null;

  const match = /resource_metadata\s*=\s*"([^"]*)"/i.exec(header);

  return match ? match[1] : null;
}

// Step 3 — prove the token actually opens the API.
//
// `variables` is optional: the query holds $placeholders and the variables
// object supplies their values, which is how you pass user input to Luca
// without pasting it into the query string.
export async function graphql({ host, endpoint, accessToken, query, variables }) {
  const url = endpoint ?? `${normalizeHost(host)}${GRAPHQL_PATH}`;
  const response = await request(url, {
    method: "POST",
    headers: headersFor(accessToken),
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });

  return {
    status: response.status,
    ms: response.ms,
    body: parseJson(response, url),
    // A refusal carries the address of the document that says how to get in.
    challenge: parseChallenge(response.headers?.get("www-authenticate")),
  };
}

export function headersFor(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// The ways a request that carried a token can still be turned away, each with
// the one thing worth doing about it. Everything here is specific to Luca's
// rules rather than to GraphQL, which is why it lives in this file.
//
// Every error carries `extensions.code`, and the code is the thing to branch
// on. There are nine, and they are coarse on purpose: a code names what an
// integration should *do* about a failure — back off, re-authorize, fix the
// query — rather than what went wrong. So one code covers several causes, and
// the `message` beside it is what says which. Show that message; never match on
// it. The four codes missing from this table — UNAUTHENTICATED, handled above,
// plus NOT_FOUND, TIMEOUT and INTERNAL_SERVER_ERROR — have no advice worth
// adding to what the message already says.
const REFUSALS = [
  {
    // The only entry that stops the whole request rather than one field, which
    // is why it comes first: nothing else in the document ran either.
    code: "RATE_LIMITED",
    say: ({ retryAfter }) =>
      retryAfter
        ? `Too many requests. Wait ${retryAfter} seconds before trying again, and back ` +
          "off rather than retrying in a loop."
        : "Too many requests. Wait a little before trying again.",
  },
  {
    // Four different refusals share this code — the company is not on the
    // consent, it is not the one an API key is bound to, the record belongs to
    // someone else, or the token may not write. Only the message tells them
    // apart, so the advice has to cover the two an integration can act on.
    code: "FORBIDDEN",
    say:
      "This token's consent does not reach that far: either the company is outside what " +
      `was granted, or the token is ${SCOPES.read} only and that was a mutation. The ` +
      "message above says which. Connect again and tick the company on Luca's consent " +
      "screen, or change the scope on the Setup page.",
  },
  {
    code: "PLAN_REQUIRED",
    say:
      "The company's Luca plan does not cover this part of the API. The message above " +
      "names what it needs; adding it is the account owner's call, not this " +
      "integration's.",
  },
  {
    // `company_id_required` lands here alongside a misspelt field, a document
    // that will not parse and one nested too deep — all of them "the query is
    // wrong and sending it again unchanged will not help".
    code: "BAD_REQUEST",
    say:
      "The document itself is wrong. Most often that is a field with no `companyId` — " +
      "pick a company in the sidebar and press Try it again — but a misspelt field or a " +
      "query that will not parse arrives the same way. The message above says which.",
  },
  {
    // The second entry to read past the code: a VALIDATION_FAILED always
    // carries `details`, one entry per failure, naming the field it is about
    // wherever there is one worth naming.
    code: "VALIDATION_FAILED",
    say: ({ details }) => {
      const fields = [...new Set((details ?? []).map(({ field }) => field).filter(Boolean))];

      return fields.length
        ? `Luca refused the values rather than the query — ${fields.join(", ")}. The message ` +
          "above says what each one expected."
        : "Luca refused the values rather than the query. The message above says what it expected.";
    },
  },
];

export function explain({ status, body }) {
  const codes = errorCodes(body);

  if (status === 401 || codes.includes("UNAUTHENTICATED")) {
    return (
      "The access token was refused. It may have expired, been revoked, or been " +
      "invalidated by a refresh token replay — connect again to get a new one."
    );
  }

  // The order of REFUSALS decides which hint wins, not the order the errors
  // happened to arrive in.
  const refusal = REFUSALS.find(({ code }) => codes.includes(code));

  if (!refusal) return null;

  return typeof refusal.say === "function"
    ? refusal.say(extensionsFor(body, refusal.code))
    : refusal.say;
}

// Every code in the document, because one document can carry several: name two
// companies in one query and get one of them wrong, and the refusal arrives
// beside the half that resolved perfectly well.
function errorCodes(body) {
  return (body?.errors ?? []).map((error) => error?.extensions?.code).filter(Boolean);
}

function extensionsFor(body, code) {
  return body?.errors?.find((error) => error?.extensions?.code === code)?.extensions ?? {};
}

async function tokenRequest(url, params) {
  const response = await request(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: formFor(params),
  });
  const body = parseJson(response, url);

  if (response.status >= 400 || !body.access_token) {
    throw new LucaError(
      tokenErrorMessage({
        status: response.status,
        body,
        grantType: params.grant_type,
        sentSecret: Boolean(params.client_secret),
      }),
    );
  }

  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: body.token_type,
    // Read the granted scope from here rather than assuming the request got
    // what it asked for — it can come back narrower.
    scope: body.scope ?? null,
    expires_in: Number(body.expires_in) || 0,
    grant_type: params.grant_type,
    obtained_at: new Date().toISOString(),
    refresh_count: 0,
  };
}

// Empty values are dropped rather than sent blank, which is what makes a
// public client work: with no secret to send, `client_secret` simply is not
// there, and PKCE is what identifies the caller.
//
// Luca also accepts the client credentials as HTTP Basic
// (`token_endpoint_auth_methods_supported`), but a form field is what shows up
// in the request log below, and watching the handshake is the point here.
function formFor(params) {
  const form = new URLSearchParams();

  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") form.set(name, value);
  }

  return form;
}

// Doorkeeper's error descriptions are accurate but written for every OAuth
// client there has ever been, so each one gets a sentence about what it
// usually means here.
const TOKEN_HINTS = {
  invalid_client:
    "The client ID is unknown, or the secret is wrong. If this application is registered " +
    "as a public client, set Client type to Public on the Setup page.",
  invalid_scope:
    "The OAuth application in Luca is not registered for one of the scopes requested. " +
    "Change the scope on the Setup page, or add it to the application in Luca.",
  invalid_request: "A required parameter was missing or malformed.",
};

const GRANT_HINTS = {
  authorization_code:
    "The code was already used, expired (they last 10 minutes), the redirect URI did not " +
    "match the one sent to /authorize, or the code_verifier did not match the challenge.",
  refresh_token:
    "This refresh token has already been used. Refresh tokens rotate: every refresh " +
    "invalidates the previous one, and replaying a used one is treated as theft — Luca " +
    "revokes the whole authorization. Connect again.",
};

function tokenErrorMessage({ status, body, grantType, sentSecret }) {
  const code = body.error ?? `HTTP ${status}`;
  // The two ways invalid_client happens point in opposite directions, and this
  // client knows which one it is: it knows whether it sent a secret.
  const hint =
    code === "invalid_grant"
      ? GRANT_HINTS[grantType]
      : code === "invalid_client" && !sentSecret
        ? "No client secret was sent. If this application is registered as confidential, " +
          "set Client type to Confidential on the Setup page and paste its secret."
        : TOKEN_HINTS[code];
  const parts = [`Token request failed (${code})`];

  if (body.error_description) parts.push(collapse(truncate(body.error_description, 300)));
  if (hint) parts.push(hint);

  return parts.join(" — ");
}

// The same treatment for the front channel, where the error arrives as query
// parameters on the callback instead of as a JSON body (RFC 6749 §4.1.2.1).
const AUTHORIZE_HINTS = {
  access_denied: "You declined the request at Luca, or picked no company. Nothing was granted.",
  invalid_scope:
    "Luca refused one of the scopes requested. An application may only ask for the scopes " +
    "it is registered for.",
  invalid_request: "Luca rejected the authorization request as malformed.",
  unauthorized_client: "This client is not allowed to use the authorization code flow.",
  server_error: "Luca hit an error while handling the authorization request.",
  temporarily_unavailable: "Luca is temporarily unable to handle the authorization request.",
};

export function authorizeErrorMessage({ error, error_description: description }) {
  const parts = [`Authorization failed (${error ?? "no error code"})`];

  if (description) parts.push(collapse(truncate(description, 300)));
  if (AUTHORIZE_HINTS[error]) parts.push(AUTHORIZE_HINTS[error]);

  return parts.join(" — ");
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

  return { status: response.status, text, ms, headers: response.headers };
}

// Node ships its own list of trusted certificate authorities and ignores the
// operating system's, so an instance behind a self-signed certificate fails
// here even when browsers and curl are perfectly happy with it. Saying so
// outright saves a long detour — "check the host setting" is the wrong advice.
// Discovery is the first call made against a new host, so this is usually
// where a certificate problem shows up first.
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

const collapse = (text) => String(text).replace(/\s+/g, " ").trim();

export function describeError(error) {
  return error instanceof LucaError ? error.message : `Unexpected error: ${error.message}`;
}
