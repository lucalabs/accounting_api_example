// Reading the endpoints instead of hardcoding them.
//
// Luca publishes two standard documents describing itself:
//
//   /.well-known/oauth-authorization-server  (RFC 8414) — where to send the
//     user, where to exchange the code, where to revoke, which PKCE methods
//     and scopes exist.
//   /.well-known/oauth-protected-resource    (RFC 9728) — the API's own
//     address and which authorization server guards it.
//
// The same Luca codebase is served under many brands on many hosts, and each
// one names itself in its own documents. Reading them is what makes one
// integration work against all of them — and it is what the help page at
// https://www.lucaregnskap.no/hjelp/api-oauth2 asks integrators to do.

import * as luca from "./luca.js";

export const METADATA_PATH = "/.well-known/oauth-authorization-server";
export const RESOURCE_PATH = "/.well-known/oauth-protected-resource";

// Where Luca happens to put these today. Only ever used when the metadata
// document cannot be read — see the note on falling back, below.
export const DEFAULT_PATHS = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  revoke: "/oauth/revoke",
  introspect: "/oauth/introspect",
};

// Keyed by host alone, unlike the schema cache in src/schema.js: that one is
// per session because what introspection returns depends on the grant behind
// the token, while this document is public, unauthenticated and identical for
// every visitor to a host.
const cache = new Map();
const inflight = new Map();
const MAX_ENTRIES = 20;

const TTL_MS = 10 * 60_000;
// A fallback entry is a record of a failure, not an answer, so it is held only
// long enough to keep one page render from making four requests.
const FALLBACK_TTL_MS = 30_000;

export function forget(host) {
  cache.delete(luca.normalizeHost(host));
}

// For templates, which cannot await. Returns whatever is already known.
export function peek(host) {
  return cache.get(luca.normalizeHost(host)) ?? null;
}

export async function discover(host) {
  const key = luca.normalizeHost(host);
  const known = cache.get(key);
  if (known && !expired(known)) return known;

  // One click on "Connect" and the page render behind it must not both fetch.
  if (inflight.has(key)) return inflight.get(key);

  const pending = read(key).finally(() => inflight.delete(key));
  inflight.set(key, pending);

  return pending;
}

async function read(key) {
  let metadata;

  try {
    metadata = validate(key, await luca.authorizationServerMetadata(`${key}${METADATA_PATH}`));
  } catch (error) {
    metadata = fallbackFor(key, luca.describeError(error));
  }

  remember(key, metadata);

  return metadata;
}

function remember(key, metadata) {
  cache.set(key, metadata);

  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

function expired({ fetchedAt, source }) {
  const ttl = source === "fallback" ? FALLBACK_TTL_MS : TTL_MS;

  return Date.now() - fetchedAt > ttl;
}

// The half of this file worth reading twice.
//
// A metadata document says where to send the user and where to POST the client
// secret. Believing a document that names someone else's host is how a mix-up
// attack starts, so the checks below are not paperwork: they are the reason it
// is safe to take endpoints from the network at all.
function validate(key, doc) {
  const issuer = String(doc.issuer ?? "").replace(/\/+$/, "");

  // RFC 8414 §3.3: you asked host X for its metadata, so only host X may name
  // itself the issuer.
  if (!issuer) throw new luca.LucaError("The metadata document names no issuer.");
  if (origin(issuer) !== origin(key)) {
    throw new luca.LucaError(`The metadata at ${key} claims to be issued by ${issuer}.`);
  }

  const authorizeEndpoint = sameOrigin(doc.authorization_endpoint, issuer, "authorization_endpoint");
  const tokenEndpoint = sameOrigin(doc.token_endpoint, issuer, "token_endpoint");
  const revocationEndpoint = doc.revocation_endpoint
    ? sameOrigin(doc.revocation_endpoint, issuer, "revocation_endpoint")
    : `${issuer}${DEFAULT_PATHS.revoke}`;
  const introspectionEndpoint = doc.introspection_endpoint
    ? sameOrigin(doc.introspection_endpoint, issuer, "introspection_endpoint")
    : null;

  const codeChallengeMethods = doc.code_challenge_methods_supported ?? [];

  return {
    host: key,
    issuer,
    authorizeEndpoint,
    tokenEndpoint,
    revocationEndpoint,
    introspectionEndpoint,
    scopesSupported: doc.scopes_supported ?? [],
    codeChallengeMethods,
    tokenAuthMethods: doc.token_endpoint_auth_methods_supported ?? [],
    issParameterSupported: Boolean(doc.authorization_response_iss_parameter_supported),
    source: "discovery",
    // Not fatal: this client only ever sends S256, so a server that does not
    // list it will simply refuse the request, with its own clearer message.
    error: codeChallengeMethods.includes("S256")
      ? null
      : `This host does not advertise S256 (${codeChallengeMethods.join(", ") || "none"}).`,
    fetchedAt: Date.now(),
  };
}

function sameOrigin(value, issuer, name) {
  if (!value) throw new luca.LucaError(`The metadata document names no ${name}.`);
  if (origin(value) !== origin(issuer)) {
    throw new luca.LucaError(`The ${name} (${value}) is on a different host than the issuer.`);
  }

  return value;
}

function origin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Guessing endpoints is exactly what this file exists to avoid, so falling
// back deserves a word. This is a teaching example whose whole job is to get
// you to a working token: a forwarding proxy that swallows /.well-known/, or a
// TLS inspection box, would otherwise end the tutorial rather than inconvenience
// it. So it guesses, and says loudly on every page that it is guessing.
//
// A production client should do the opposite — fail closed, or ship endpoints
// pinned at build time. Half-trusting a document you could not read is how you
// end up sending a client secret somewhere unexpected.
function fallbackFor(key, error) {
  return {
    host: key,
    issuer: key,
    authorizeEndpoint: `${key}${DEFAULT_PATHS.authorize}`,
    tokenEndpoint: `${key}${DEFAULT_PATHS.token}`,
    revocationEndpoint: `${key}${DEFAULT_PATHS.revoke}`,
    introspectionEndpoint: `${key}${DEFAULT_PATHS.introspect}`,
    scopesSupported: [luca.SCOPES.read, luca.SCOPES.write],
    codeChallengeMethods: [],
    tokenAuthMethods: [],
    // Unknown rather than false, so the callback does not refuse a response for
    // lacking an `iss` the server may never have promised.
    issParameterSupported: null,
    source: "fallback",
    error,
    fetchedAt: Date.now(),
  };
}

// The resource half of the pair. `url` is usually the address a 401 handed us
// in its WWW-Authenticate challenge, which is the whole point: a client can
// meet the API cold, be refused, and learn from the refusal alone which
// authorization server to go to. That is how an MCP client bootstraps.
//
// Returns null rather than throwing — nothing here is load-bearing; it makes
// the request bar honest and gives a 401 something useful to say.
export async function discoverResource(host, url) {
  const key = luca.normalizeHost(host);
  const address = url ?? `${key}${RESOURCE_PATH}`;

  try {
    const doc = await luca.protectedResourceMetadata(address);
    const servers = doc.authorization_servers ?? [];

    // The document exists to tie a resource to its authorization server, so a
    // resource pointing somewhere other than the host we authorized against is
    // precisely the confusion it is meant to prevent.
    if (servers.length && origin(servers[0]) !== origin(key)) {
      throw new luca.LucaError(
        `${address} says it is guarded by ${servers[0]}, not by ${key}. Refusing to use it.`,
      );
    }

    return {
      resource: doc.resource ?? null,
      authorizationServers: servers,
      scopesSupported: doc.scopes_supported ?? [],
      resourceDocumentation: doc.resource_documentation ?? null,
      error: null,
    };
  } catch (error) {
    return { resource: null, authorizationServers: [], scopesSupported: [],
             resourceDocumentation: null, error: luca.describeError(error) };
  }
}
