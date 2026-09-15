import { Router } from "express";

import * as luca from "../luca.js";
import * as discovery from "../discovery.js";
import * as schemas from "../schema.js";
import { notice } from "../flash.js";

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

  if (req.body.clientType === "public") {
    // Stored as an empty string rather than deleted. Deleting would let the
    // session fall back to CLIENT_SECRET from .env, and the next exchange would
    // quietly be confidential again — an answer of "no secret" has to be
    // recorded, not merely left blank.
    credentials.clientSecret = "";
  } else {
    const secret = (req.body.clientSecret ?? "").trim();
    if (secret) credentials.clientSecret = secret;
  }

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

    notice(req, "Credentials saved. The old token was dropped — connect again.");
  } else {
    notice(req, "Credentials saved for this session.");
  }

  res.redirect("/");
});

router.post("/setup/forget", (req, res) => {
  schemas.forget(req.sessionID, luca.normalizeHost(req.credentials.host));
  delete req.session.credentials;
  delete req.session.token;
  delete req.session.pending;

  notice(req, "Credentials and tokens forgotten.");
  res.redirect("/setup");
});

export default router;
