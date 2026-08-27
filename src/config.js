import "dotenv/config";
import { randomUUID } from "node:crypto";

import { DEFAULT_HOST } from "./luca.js";

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
};

export function credentialsFor(session) {
  const saved = session.credentials ?? {};

  return {
    host: saved.host ?? fromEnv.host,
    clientId: saved.clientId ?? fromEnv.clientId,
    clientSecret: saved.clientSecret ?? fromEnv.clientSecret,
  };
}

// Must match a redirect URI registered on your Luca OAuth application, so it is
// derived once here and used by both /oauth/authorize and /oauth/callback.
export function redirectUriFor(req) {
  if (config.redirectUri) return config.redirectUri;

  return `${req.protocol}://${req.get("host")}/oauth/callback`;
}
