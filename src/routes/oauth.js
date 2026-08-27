// The OAuth2 dance:
//
//   GET  /oauth/authorize   send the user to Luca to grant access
//   GET  /oauth/callback    Luca sends them back here with a code
//   POST /oauth/refresh     swap the refresh token for a fresh pair
//   POST /oauth/disconnect  drop the tokens

import { Router } from "express";

import * as luca from "../luca.js";
import { redirectUriFor } from "../config.js";
import { requireCredentials, requireToken } from "../guards.js";
import { notice, alert } from "../flash.js";

const router = Router();

// Step 1 — hand the user over to Luca, which signs them in and asks which
// company this integration may read.
router.get("/authorize", requireCredentials, (req, res) => {
  res.redirect(luca.authorizeUrl({ ...req.credentials, redirectUri: redirectUriFor(req) }));
});

// Step 2 — Luca redirects back with ?code=…&scope=…, and we swap that
// single-use code for tokens. This half happens server-to-server, so the client
// secret never reaches the browser.
router.get("/callback", async (req, res) => {
  if (!req.query.code) {
    alert(req, "Authorization was denied or cancelled (no code returned).");
    return res.redirect("/");
  }

  try {
    req.session.token = await luca.exchangeCode({
      ...req.credentials,
      code: req.query.code,
      redirectUri: redirectUriFor(req),
    });
    req.session.grantedScope = req.query.scope ?? null;

    notice(req, "Access granted — token received from Luca.");
  } catch (error) {
    alert(req, luca.describeError(error));
  }

  res.redirect("/");
});

// Step 3 — the same token endpoint, but with no user present at all.
router.post("/refresh", requireToken, async (req, res) => {
  const previous = req.session.token;

  try {
    const current = await luca.refresh({
      ...req.credentials,
      refreshToken: previous.refresh_token,
    });
    req.session.token = { ...current, refresh_count: previous.refresh_count + 1 };

    notice(req, rotationNotice(previous, req.session.token));
  } catch (error) {
    alert(req, `Refresh failed: ${luca.describeError(error)}`);
  }

  res.redirect("/");
});

router.post("/disconnect", (req, res) => {
  delete req.session.token;
  delete req.session.grantedScope;

  notice(req, "Disconnected — tokens dropped. Your credentials are still saved.");
  res.redirect("/");
});

// The point of the refresh button is to prove Luca really rotated both tokens,
// so say which of them actually changed.
function rotationNotice(previous, current) {
  const rotated = [
    current.access_token !== previous.access_token && "access",
    current.refresh_token !== previous.refresh_token && "refresh",
  ].filter(Boolean);

  if (rotated.length === 0) return "Token refreshed, but Luca returned the same tokens.";

  return `Token refreshed — new ${rotated.join(" and ")} token${rotated.length > 1 ? "s" : ""} issued.`;
}

export default router;
