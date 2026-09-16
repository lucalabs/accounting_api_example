// The OAuth 2.1 dance:
//
//   GET  /oauth/authorize   send the user to Luca to grant access
//   GET  /oauth/callback    Luca sends them back here with a code
//   POST /oauth/refresh     swap the refresh token for a fresh pair
//   POST /oauth/disconnect  revoke at Luca, then drop the tokens
//
// Every endpoint is read from the host's metadata document first — see
// src/discovery.js — so nothing below glues a path onto a host.

import { Router } from "express";

import * as luca from "../luca.js";
import * as discovery from "../discovery.js";
import * as schemas from "../schema.js";
import { redirectUriFor } from "../config.js";
import { requireCredentials, requireToken } from "../guards.js";
import { notice, alert } from "../flash.js";

const router = Router();

// An authorization code is good for ten minutes, so a consent screen left open
// for longer than that cannot produce a working code anyway.
const PENDING_MS = 10 * 60_000;

// Step 1 — hand the user over to Luca, which signs them in and asks which of
// their companies this integration may reach.
router.get("/authorize", requireCredentials, async (req, res) => {
  const { host, clientId, scope } = req.credentials;
  const metadata = await discovery.discover(host);
  const redirectUri = redirectUriFor(req);

  const { verifier, challenge } = luca.createPkce();
  const state = luca.randomState();

  // Everything the callback needs to finish, captured now. The endpoints and
  // client ID are copied in rather than re-read later, so editing the Setup
  // page in another tab while the consent screen is open cannot make the
  // exchange finish against different values than it started with.
  //
  // The verifier never leaves this server: the browser only ever holds the
  // session cookie that points at it.
  req.session.pending = {
    state,
    verifier,
    issuer: metadata.issuer,
    issExpected: metadata.issParameterSupported,
    tokenEndpoint: metadata.tokenEndpoint,
    clientId,
    redirectUri,
    scope,
    createdAt: Date.now(),
  };

  if (metadata.source === "fallback") {
    notice(req, `Could not read ${host}'s metadata document, so the default endpoints are assumed.`);
  }

  const url = luca.authorizeUrl({
    endpoint: metadata.authorizeEndpoint,
    clientId,
    redirectUri,
    scope,
    state,
    codeChallenge: challenge,
  });

  // Saved explicitly before control leaves for Luca. The redirect would write
  // the session anyway, but with a real store this is the habit that keeps the
  // verifier from racing the callback.
  req.session.save(() => res.redirect(url));
});

// Step 2 — Luca redirects back with ?code=…&state=…&iss=…, and we swap that
// single-use code for tokens. This half happens server-to-server, so a
// confidential client's secret never reaches the browser.
router.get("/callback", async (req, res) => {
  // Taken and cleared first thing, on every path: a code verifier is
  // single-use, and leaving a spent one in the session invites replaying it.
  const pending = req.session.pending;
  delete req.session.pending;

  // `server.js` parses the query string with URLSearchParams and keeps the
  // last value for a repeated key, so a duplicated `state` or `iss` cannot
  // smuggle a second value past the comparisons below — it fails closed.
  const { code, state, iss, error } = req.query;

  try {
    if (!pending) {
      throw new luca.LucaError(
        "There is no authorization in progress in this session. Start from " +
          "Connect to Luca — this callback may be a stale bookmark, a reload, " +
          "or a different browser.",
      );
    }

    if (Date.now() - pending.createdAt > PENDING_MS) {
      throw new luca.LucaError(
        "That authorization took more than 10 minutes, so the code would already " +
          "have expired. Start again.",
      );
    }

    // Luca reports a refusal on the front channel, as query parameters. Check
    // `state` first where there is one, so nobody can hand this app a URL that
    // paints an arbitrary error across the page — but a missing state on an
    // error response is not itself worth a second message.
    if (error) {
      if (state && state !== pending.state) throw stateMismatch();

      throw new luca.LucaError(luca.authorizeErrorMessage(req.query));
    }

    // The point of `state`: only a callback carrying the value this app
    // generated belongs to the authorization this app started. Anything else is
    // refused before the code is spent, not after.
    if (!state || state !== pending.state) throw stateMismatch();

    // RFC 9207. `iss` names the authorization server that produced the
    // response, which is what stops a client that talks to several from being
    // tricked into redeeming one server's code at another.
    checkIssuer(iss, pending);

    if (!code) throw new luca.LucaError("No authorization code in the callback.");

    if (pending.clientId !== req.credentials.clientId) {
      throw new luca.LucaError("The client ID changed while you were authorizing. Start again.");
    }

    req.session.token = await luca.exchangeCode({
      tokenEndpoint: pending.tokenEndpoint,
      clientId: pending.clientId,
      clientSecret: req.credentials.clientSecret,
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.verifier,
    });

    // A new grant can cover a different set of companies than the last one, and
    // the schema a token sees depends on its grant, so neither survives here.
    schemas.forget(req.sessionID, luca.normalizeHost(req.credentials.host));

    notice(req, `Access granted — scope: ${req.session.token.scope ?? "not reported"}.`);
  } catch (failure) {
    alert(req, luca.describeError(failure));
  }

  res.redirect("/");
});

function stateMismatch() {
  return new luca.LucaError(
    "Rejected this callback without redeeming the code: the state value did not " +
      "match the one this app generated. state is what ties a callback to the " +
      "request that started it, so a mismatch means this response did not come " +
      "from the authorization you began here.",
  );
}

function checkIssuer(iss, pending) {
  const expected = String(pending.issuer).replace(/\/+$/, "");
  const actual = String(iss ?? "").replace(/\/+$/, "");

  if (actual && actual !== expected) {
    throw new luca.LucaError(
      `Rejected this callback without redeeming the code: it says it came from ` +
        `${actual}, but the authorization was started at ${expected}.`,
    );
  }

  // Only demanded when discovery said the server sends one. In fallback mode
  // there is no metadata to promise it, so its absence proves nothing.
  if (!actual && pending.issExpected) {
    throw new luca.LucaError(
      "Rejected this callback without redeeming the code: Luca advertises RFC 9207 " +
        "iss on authorization responses and this one carries none, so it cannot be " +
        "confirmed to have come from the right authorization server.",
    );
  }
}

// Step 3 — the same token endpoint, but with no user present at all.
router.post("/refresh", requireToken, async (req, res) => {
  const previous = req.session.token;

  try {
    const metadata = await discovery.discover(req.credentials.host);
    const current = await luca.refresh({
      tokenEndpoint: metadata.tokenEndpoint,
      clientId: req.credentials.clientId,
      clientSecret: req.credentials.clientSecret,
      refreshToken: previous.refresh_token,
    });
    req.session.token = { ...current, refresh_count: previous.refresh_count + 1 };

    notice(req, rotationNotice(previous, req.session.token));
  } catch (error) {
    alert(req, `Refresh failed: ${luca.describeError(error)}`);
  }

  res.redirect("/");
});

router.post("/disconnect", requireToken, async (req, res) => {
  const token = req.session.token;
  let failure = null;

  try {
    const metadata = await discovery.discover(req.credentials.host);

    // Revoke the refresh token, not the access token. Both belong to one
    // authorization, and revoking the refresh token takes the access token with
    // it — the other way round leaves a refresh token alive that can mint a new
    // access token, which is exactly the mistake worth not modelling here.
    await luca.revokeToken({
      revocationEndpoint: metadata.revocationEndpoint,
      clientId: req.credentials.clientId,
      clientSecret: req.credentials.clientSecret,
      token: token.refresh_token ?? token.access_token,
      tokenTypeHint: token.refresh_token ? "refresh_token" : "access_token",
    });
  } catch (error) {
    failure = luca.describeError(error);
  }

  // Dropped whether or not Luca accepted the revocation: an app that says it
  // has disconnected must not still be holding tokens.
  delete req.session.token;
  delete req.session.pending;
  schemas.forget(req.sessionID, luca.normalizeHost(req.credentials.host));

  if (failure) {
    alert(req, `Luca did not accept the revocation (${failure}). The local tokens were dropped anyway.`);
  } else {
    notice(req, "Revoked at Luca and disconnected. Your credentials are still saved.");
  }

  res.redirect("/");
});

// The point of the refresh button is to prove Luca really rotated both tokens,
// so say which of them actually changed. Under OAuth 2.1 rotation is not
// optional, so a refresh token that comes back unchanged is a finding.
function rotationNotice(previous, current) {
  const rotated = [
    current.access_token !== previous.access_token && "access",
    current.refresh_token !== previous.refresh_token && "refresh",
  ].filter(Boolean);

  if (!rotated.includes("refresh")) {
    return "Token refreshed, but Luca returned the same refresh token — rotation did not happen.";
  }

  return `Token refreshed — new ${rotated.join(" and ")} token${rotated.length > 1 ? "s" : ""} issued. The previous refresh token is now dead.`;
}

export default router;
