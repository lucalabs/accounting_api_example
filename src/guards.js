import { missingSecret } from "./config.js";
import { alert } from "./flash.js";

export function requireCredentials(req, res, next) {
  if (!req.credentials.clientId) {
    alert(req, "Start by entering your client ID.");

    return res.redirect("/setup");
  }

  // A public client has no secret, and that is fine. A confidential one without
  // a secret cannot finish the exchange, so stop before sending the user to
  // Luca to approve an authorization that is going to die on the way back.
  if (missingSecret(req.credentials)) {
    alert(
      req,
      "This client is set to Confidential but has no client secret stored, so " +
        "the token exchange would be refused. Paste the secret, or switch Client " +
        "type to Public.",
    );

    return res.redirect("/setup");
  }

  next();
}

export function requireToken(req, res, next) {
  if (req.session.token) return next();

  alert(req, "Connect to Luca first.");
  res.redirect("/");
}
