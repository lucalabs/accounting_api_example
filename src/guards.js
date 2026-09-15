import { alert } from "./flash.js";

export function requireCredentials(req, res, next) {
  // Only the client ID is required: a public client has no secret at all.
  if (req.credentials.clientId) return next();

  alert(req, "Start by entering your client ID.");
  res.redirect("/setup");
}

export function requireToken(req, res, next) {
  if (req.session.token) return next();

  alert(req, "Connect to Luca first.");
  res.redirect("/");
}
