// Logs every call this app makes to Luca, so you can watch the OAuth handshake
// happen in your terminal:
//
//   → POST https://go.lucaregnskap.no/api/v1/oauth2/token
//     grant_type=authorization_code  code=«redacted, 43 chars»  client_id=6d0f…
//   ← 200 in 412ms
//     access_token=«redacted, 632 chars»  token_type=bearer  expires_in=3600
//
// Secrets are redacted and the GraphQL payload is summarised, so the logs are
// safe to paste into a bug report.

// `code` means different things in each direction: on the way out it is the
// single-use authorization code, on the way back it is Luca's status number.
const SENT_SECRETS = new Set(["client_secret", "code", "refresh_token"]);
const RECEIVED_SECRETS = new Set(["access_token", "refresh_token"]);

// Not a secret, but not printable either: `data` is whatever you asked Luca
// for — invoices, ledger rows, customer names. `errors` stays visible.
const PRIVATE = new Set(["data"]);

const MAX_VALUE = 160;
const MAX_BODY = 200;

export function logRequest(method, url, body) {
  console.log(`\n→ ${method} ${url}`);
  write(describeRequest(body));
}

export function logResponse(status, ms, text) {
  console.log(`← ${status} in ${ms}ms`);
  write(describeResponse(text));
}

export function logFailure(reason, ms) {
  console.log(`← no response after ${ms}ms: ${reason}`);
}

function write(summary) {
  if (summary) console.log(`  ${summary}`);
}

// Token requests send a form; the GraphQL call sends JSON.
function describeRequest(body) {
  if (!body) return "";

  if (body instanceof URLSearchParams) return fields([...body], SENT_SECRETS);

  try {
    const { query } = JSON.parse(body);
    return query ? `query: ${collapse(truncate(query, MAX_BODY))}` : "";
  } catch {
    return "";
  }
}

function describeResponse(text) {
  const parsed = tryParse(text);
  if (!parsed || typeof parsed !== "object") return collapse(truncate(text, MAX_BODY));

  return fields(Object.entries(parsed), RECEIVED_SECRETS);
}

function fields(entries, secrets) {
  return entries.map(([key, value]) => `${key}=${present(key, value, secrets)}`).join("  ");
}

function present(key, value, secrets) {
  const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

  if (secrets.has(key)) return `«redacted, ${text.length} chars»`;
  if (PRIVATE.has(key)) return `«${text.length} chars of response data»`;

  return collapse(truncate(text, MAX_VALUE));
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const collapse = (text) => text.replace(/\s+/g, " ").trim();
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
