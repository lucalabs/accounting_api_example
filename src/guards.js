import { alert } from "./flash.js";

export function requireCredentials(req, res, next) {
  const { clientId, clientSecret } = req.credentials;
  if (clientId && clientSecret) return next();

  alert(req, "Start by entering your client ID and secret.");
  res.redirect("/setup");
}

export function requireToken(req, res, next) {
  if (req.session.token) return next();

  alert(req, "Connect to Luca first.");
  res.redirect("/");
}
