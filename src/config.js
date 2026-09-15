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
  // Blank is a valid answer: an application registered as a public client has
  // no secret, and PKCE is what proves the exchange came from whoever started
  // the flow.
  clientSecret: process.env.CLIENT_SECRET || "",
  scope: process.env.SCOPE || DEFAULT_SCOPE,
};

export function credentialsFor(session) {
  const saved = session.credentials ?? {};

  return {
    host: saved.host ?? fromEnv.host,
    clientId: saved.clientId ?? fromEnv.clientId,
    clientSecret: saved.clientSecret ?? fromEnv.clientSecret,
    scope: saved.scope ?? fromEnv.scope,
  };
}

// Must match a redirect URI registered on your Luca OAuth application — Luca
// compares them character for character — so it is derived once here and used
// by both /oauth/authorize and /oauth/callback.
export function redirectUriFor(req) {
  if (config.redirectUri) return config.redirectUri;

  return `${req.protocol}://${req.get("host")}/oauth/callback`;
}
