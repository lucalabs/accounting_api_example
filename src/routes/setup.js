import { Router } from "express";

import * as luca from "../luca.js";
import * as discovery from "../discovery.js";
import * as schemas from "../schema.js";
import { hasEnvCredentials, credentialsFor, missingSecret } from "../config.js";
import { notice, alert } from "../flash.js";

const router = Router();

// Built here rather than taken from the form, so nothing a browser posts is
// ever pasted straight into an authorize URL.
const SCOPE_CHOICES = {
  read: luca.SCOPES.read,
  write: `${luca.SCOPES.read} ${luca.SCOPES.write}`,
};

router.get("/setup", async (req, res) => {
  const host = luca.normalizeHost(req.credentials.host);

  if (req.query.rediscover) discovery.forget(host);

  res.render("layout", {
    page: "pages/setup",
    title: "Setup",
    metadata: await discovery.discover(host),
  });
});

router.post("/setup", (req, res) => {
  const before = req.credentials;
  const credentials = req.session.credentials ?? {};

  credentials.host = luca.normalizeHost(req.body.host);
  credentials.clientId = (req.body.clientId ?? "").trim();
  credentials.scope = SCOPE_CHOICES[req.body.scope] ?? luca.DEFAULT_SCOPE;

  // The choice itself is what gets recorded. The secret is kept either way, so
  // a trip through public mode does not throw it away — credentialsFor simply
  // stops sending it while public is selected.
  credentials.clientType = req.body.clientType === "public" ? "public" : "confidential";

  const secret = (req.body.clientSecret ?? "").trim();
  if (secret) credentials.clientSecret = secret;

  req.session.credentials = credentials;

  // A Luca access token is only meaningful to the instance that issued it and
  // the client it was issued to, and its scope is fixed at the moment it is
  // granted — so a change to any of the three invalidates the token here.
  const reissued =
    credentials.host !== luca.normalizeHost(before.host) ||
    credentials.clientId !== before.clientId ||
    credentials.scope !== before.scope;

  if (credentials.host !== luca.normalizeHost(before.host)) {
    discovery.forget(before.host);
  }

  if (reissued && req.session.token) {
    delete req.session.token;
    delete req.session.pending;
    schemas.forget(req.sessionID, luca.normalizeHost(before.host));
  }

  // Caught here rather than at the token endpoint: Luca would answer
  // invalid_client, which is true but says nothing about which of the two
  // fields on this page is wrong.
  if (missingSecret(credentialsFor(req.session))) {
    alert(
      req,
      "Saved — but a confidential client needs a client secret, and none is stored. " +
        "Paste the one Luca showed you when the application was created, or switch " +
        "Client type to Public if it was registered without a secret.",
    );

    return res.redirect("/setup");
  }

  notice(
    req,
    reissued && !req.session.token
      ? "Credentials saved. The old token was dropped — connect again."
      : "Credentials saved for this session.",
  );

  res.redirect("/");
});

router.post("/setup/forget", (req, res) => {
  schemas.forget(req.sessionID, luca.normalizeHost(req.credentials.host));
  delete req.session.credentials;
  delete req.session.token;
  delete req.session.pending;

  // Forget only clears what was typed into the form. Anything in .env is still
  // there and the form falls straight back to it, so say so rather than letting
  // the button look like it did nothing.
  notice(
    req,
    hasEnvCredentials()
      ? "Cleared what you typed, and dropped the tokens. The form has fallen back to the values in .env — edit that file to change those."
      : "Credentials and tokens forgotten.",
  );
  res.redirect("/setup");
});

export default router;
