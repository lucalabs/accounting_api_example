import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import session from "express-session";

import * as luca from "./src/luca.js";
import * as viewHelpers from "./src/view-helpers.js";
import { config, credentialsFor, redirectUriFor } from "./src/config.js";

import homeRoutes from "./src/routes/home.js";
import setupRoutes from "./src/routes/setup.js";
import oauthRoutes from "./src/routes/oauth.js";
import apiRoutes from "./src/routes/api.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const app = express();

app.set("view engine", "ejs");
app.set("views", join(ROOT, "views"));

Object.assign(app.locals, viewHelpers, { luca });

app.set("query parser", (query) => Object.fromEntries(new URLSearchParams(query)));

app.use(express.static(join(ROOT, "public")));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  for (const [name, value] of Object.entries(req.body ?? {})) {
    if (Array.isArray(value)) req.body[name] = value.at(-1);
  }

  next();
});

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      // Lax is required: the OAuth callback is a top-level navigation from Luca
      // back to us, and Lax is what lets the cookie ride along with it.
      sameSite: "lax",
    },
  }),
);

app.use((req, res, next) => {
  // RFC 6749 §5.1: a response carrying tokens must not be stored, and every
  // page below this line can show one.
  res.set("Cache-Control", "no-store");

  req.credentials = credentialsFor(req.session);

  res.locals.credentials = req.credentials;
  res.locals.redirectUri = redirectUriFor(req);
  res.locals.token = req.session.token ?? null;
  res.locals.grantedScope = req.session.grantedScope ?? null;
  res.locals.title = "";
  res.locals.wide = false;
  res.locals.path = req.path;

  res.locals.flash = req.session.flash ?? null;
  delete req.session.flash;

  next();
});

app.use(homeRoutes);
app.use(setupRoutes);
app.use("/oauth", oauthRoutes);
app.use(apiRoutes);

app.get("/health", (req, res) => res.type("text").send("ok"));

app.use((error, req, res, next) => {
  const status = error.status ?? error.statusCode ?? 500;
  console.error(error);

  res
    .status(status)
    .type("text")
    .send(status < 500 ? error.message : "Internal server error");
});

app.listen(config.port, () => {
  console.log(`Luca API example → http://localhost:${config.port}`);
});
