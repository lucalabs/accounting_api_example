import { Router } from "express";

import { normalizeHost } from "../luca.js";
import { notice } from "../flash.js";

const router = Router();

router.get("/setup", (req, res) => {
  res.render("layout", { page: "pages/setup", title: "Setup" });
});

router.post("/setup", (req, res) => {
  const before = req.credentials;
  const credentials = req.session.credentials ?? {};

  credentials.host = normalizeHost(req.body.host);
  credentials.clientId = (req.body.clientId ?? "").trim();

  const secret = (req.body.clientSecret ?? "").trim();
  if (secret) credentials.clientSecret = secret;

  req.session.credentials = credentials;

  // A Luca access token is only meaningful to the instance that issued it and
  // the client it was issued to, so a change to either invalidates it here.
  const reissued =
    credentials.host !== normalizeHost(before.host) || credentials.clientId !== before.clientId;

  if (reissued && req.session.token) {
    delete req.session.token;
    delete req.session.grantedScope;

    notice(req, "Credentials saved. The old token was dropped — connect again.");
  } else {
    notice(req, "Credentials saved for this session.");
  }

  res.redirect("/");
});

router.post("/setup/forget", (req, res) => {
  delete req.session.credentials;
  delete req.session.token;
  delete req.session.grantedScope;

  notice(req, "Credentials and tokens forgotten.");
  res.redirect("/setup");
});

export default router;
