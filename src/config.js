import "dotenv/config";
import { randomUUID } from "node:crypto";

import { DEFAULT_HOST, DEFAULT_SCOPE } from "./luca.js";

export const config = {
  port: Number(process.env.PORT) || 8080,

  sessionSecret: process.env.SESSION_SECRET || randomUUID(),

  // Only needed when the redirect URI registered in Luca is not the one this
  // server works out for itself — behind a tunnel or a proxy, say.
  redirectUri: process.env.REDIRECT_URI || null,
};

const fromEnv = {
  host: process.env.HOST || DEFAULT_HOST,
  clientId: process.env.CLIENT_ID || "",
  clientSecret: process.env.CLIENT_SECRET || "",
  scope: process.env.SCOPE || DEFAULT_SCOPE,
  // A secret in .env means a confidential application; none means a public one.
  // Only a starting guess — the Setup page records the answer explicitly.
  clientType: process.env.CLIENT_SECRET ? "confidential" : "public",
};

export function credentialsFor(session) {
  const saved = session.credentials ?? {};
  const clientType = saved.clientType ?? fromEnv.clientType;
  const stored = saved.clientSecret ?? fromEnv.clientSecret;

  return {
    host: saved.host ?? fromEnv.host,
    clientId: saved.clientId ?? fromEnv.clientId,
    scope: saved.scope ?? fromEnv.scope,
    clientType,

    // The client type is recorded rather than inferred from whether a secret is
    // present, because those are not the same question. "Confidential, but the
    // secret is missing" is a mistake worth catching; inferring would silently
    // call it a public client and send no secret, and Luca would answer
    // invalid_client with nothing pointing at the real cause.
    //
    // The stored secret survives a trip through public mode, so switching back
    // does not mean pasting it again — it is simply not sent meanwhile.
    clientSecret: clientType === "public" ? "" : stored,
    hasStoredSecret: Boolean(stored),
  };
}

// A confidential client that has no secret to send cannot complete the
// exchange, and it is the one combination the Setup page can produce by
// accident — pick Public, save, then pick Confidential again.
export function missingSecret(credentials) {
  return credentials.clientType === "confidential" && !credentials.clientSecret;
}

// Where each value above actually came from. The Setup page shows this, because
// otherwise "Forget" looks broken: it clears what you typed, the form falls
// straight back to .env, and the same client ID is on screen a moment later.
export function sourcesFor(session) {
  const saved = session.credentials ?? {};
  const from = (key) => (saved[key] !== undefined ? "form" : process.env[ENV_NAMES[key]] ? ".env" : "default");

  return Object.fromEntries(Object.keys(ENV_NAMES).map((key) => [key, from(key)]));
}

const ENV_NAMES = {
  host: "HOST",
  clientId: "CLIENT_ID",
  clientSecret: "CLIENT_SECRET",
  scope: "SCOPE",
};

// Does .env have anything for the form to fall back to? Decides what the
// Forget button can honestly promise.
export function hasEnvCredentials() {
  return Boolean(process.env.CLIENT_ID || process.env.CLIENT_SECRET);
}

// Must match a redirect URI registered on your Luca OAuth application — Luca
// compares them character for character — so it is derived once here and used
// by both /oauth/authorize and /oauth/callback.
export function redirectUriFor(req) {
  if (config.redirectUri) return config.redirectUri;

  return `${req.protocol}://${req.get("host")}/oauth/callback`;
}
