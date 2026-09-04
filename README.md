# Luca API example

A small Express app for connecting to the [Luca](https://go.lucaregnskap.no) accounting API: the
OAuth2 **authorization-code** flow end to end — grant access, get redirected back, exchange the
code for tokens, refresh them — and then a page for exploring the GraphQL API with the token you
just got.

You enter your own client ID and secret in the browser — there is no config file to edit and
nothing is written to disk.

```sh
npm install
npm start
```

Then open <http://localhost:8080>. (Bun works too: `bun install && bun server.js`.)

## What it demonstrates

| Step | Call |
| --- | --- |
| 1. Authorize | Browser → `GET {host}/api/v1/oauth2/authorize?client_id&response_type=code&redirect_uri&scope=accounting` |
| 2. Callback | Luca → `{redirect_uri}?code=…&scope=…` |
| 3. Exchange | Server → `POST {host}/api/v1/oauth2/token` with `grant_type=authorization_code` |
| 4. Refresh | Server → same endpoint with `grant_type=refresh_token` |
| 5. Use it | Server → `POST {host}/api/v1/graphql` with `Authorization: Bearer <access_token>` |

Steps 3–5 are server-to-server, so your client secret never reaches the browser.

## Before you start

You need an OAuth application registered in Luca, with:

- **Redirect URI** — `http://localhost:8080/oauth/callback`, exactly. Luca matches it against what
  you register, so if you change the port, change the registration too.
- **Client ID** and **client secret** — paste them into the form on the page.

Node.js 20 or newer. No database, no build step.

## How the code is laid out

The app is three pages, in the order you use them:

| Page | What it does |
| --- | --- |
| `/setup` | Enter your client ID, secret and host. Where you land with nothing configured. |
| `/` | Verify the OAuth2 flow: connect, inspect the token, refresh it. |
| `/api` | Explore the API and run queries against it. Needs a token. |

Each file does one thing, so you can read them in the order the flow happens.

| File | What it does |
| --- | --- |
| `server.js` | Assembly only: middleware, routers, listen |
| `src/luca.js` | Talks to Luca — the only file that knows the API |
| `src/schema.js` | GraphQL introspection: what the API offers, and example queries |
| `src/highlight.js` | Colours the JSON response |
| `src/config.js` | Where credentials come from, and in what order |
| `src/routes/setup.js` | The credential form |
| `src/routes/home.js` | `GET /` — the connection page |
| `src/routes/oauth.js` | Authorize, callback, refresh, disconnect |
| `src/routes/api.js` | The API page and running queries |
| `src/logger.js` | Prints every call to Luca, with secrets redacted |
| `src/guards.js` | Sends you to the page that fixes the problem |
| `src/flash.js` | One-shot messages between redirects |
| `src/view-helpers.js` | Time formatting, and type names linked to their docs |
| `views/layout.ejs` | The shell and navigation, used by every page |
| `views/pages/*.ejs` | One file per page |
| `views/partials/*.ejs` | Nav, flash, token card, schema listing, type docs |
| `public/complete.js` | Autocomplete for the query editor — the only client-side code |
| `public/style.css` | The whole look |

Start with `src/luca.js` if you only care about the API calls, or `src/routes/oauth.js` if you want
to see the flow.

## Configuration

The form on the page is all you need. If you would rather not retype credentials after every
restart, copy `.env.example` to `.env` and fill it in:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `https://go.lucaregnskap.no` | The Luca instance to talk to |
| `CLIENT_ID` | — | Prefills the form |
| `CLIENT_SECRET` | — | Prefills the form |
| `PORT` | `8080` | Port to listen on |
| `REDIRECT_URI` | derived from the request | Override when behind a tunnel or proxy |
| `SESSION_SECRET` | random per boot | Signs the session cookie |

The three Luca settings are prefixed on purpose: a bare `HOST` means the bind address to much of
the Node ecosystem, and one already exported in your shell would otherwise send this app's token
exchange somewhere surprising.

Values typed into the form win over `.env` for the rest of your session.

## Watching the requests

Every call this app makes to Luca is printed to the terminal, so you can follow the handshake as
it happens:

```
→ POST https://go.lucaregnskap.no/api/v1/oauth2/token
  grant_type=authorization_code  code=«redacted, 43 chars»  redirect_uri=http://localhost:8080/oauth/callback  client_id=6d0f…  client_secret=«redacted, 64 chars»
← 200 in 412ms
  status=ok  access_token=«redacted, 632 chars»  refresh_token=«redacted, 100 chars»  token_type=bearer  expires_in=3600
```

Secrets are replaced with `«redacted»`, keeping their length so you can still tell that something
came back, and a GraphQL reply's `data` is summarised as a size rather than printed — it is your
accounting data, and these logs end up in screenshots. Everything else — grant type, redirect URI,
client ID, timings, GraphQL `errors`, error descriptions — is printed in full, which is usually
what you need when a handshake fails. The logs are safe to paste into an issue.

All of it lives in `src/logger.js`, called from the three `logRequest` / `logResponse` /
`logFailure` calls in the single `request` function in `src/luca.js`. Remove those calls to turn
it off.

## Exploring the API

The `/api` page is laid out like a REST client — request on the left, schema on the right:

- a **request bar** showing the exact endpoint being called
- a **query editor**, with a **Variables** panel for GraphQL variables as JSON
- a **Headers** panel showing precisely what gets sent, including the bearer token
- the **response**, syntax-highlighted, with its status and round-trip time
- a **searchable schema sidebar** listing every query and mutation with its arguments,
  types and description

The sidebar comes from introspection — every GraphQL API answers a `__schema` query describing
itself — so nothing in it is hardcoded and it stays correct as the API changes. **Try it** next to
any field loads a runnable example into the editor. Fields with required arguments come out as a
query with `$variables`, and the Variables panel opens prefilled with the names to supply — so the
example passes GraphQL validation and the only thing left to do is type a real value.

Introspection needs a valid access token, and the result is cached per host for your session —
**Reload** fetches it again.

### Reading the schema

Every type name in the sidebar is a link. Following one replaces the field list with that type's
own documentation — its fields and their types, an input object's fields, an enum's values, a
union's members, an interface's implementors — and each of *those* type names is a link too, so you
can walk from `companies` down to the shape of a single line on an invoice without leaving the page.
**← All fields** goes back. Whatever is in the editor travels along in the URL, so reading the docs
never costs you the query you were writing.

This is the same information a `__schema` query returns, laid out one type at a time: `src/schema.js`
asks for it once, and `views/partials/type-doc.ejs` renders it.

### Autocomplete

Typing a field name in the editor offers the fields that are actually valid at the cursor, with the
type each one returns and the first line of its description. Arrow keys move, `Enter` or `Tab`
accepts, `Esc` dismisses, and `Ctrl-Space` asks for the full list without typing anything first.

`public/complete.js` is the only client-side code in the project, and nothing depends on it: the
editor is a plain `<textarea>` in a form that posts to the server, so with JavaScript off you type
field names yourself and every other part of the page — search, **Try it**, the type docs, sending
the query — still works, because all of them are links and form posts. It reads the schema from
`GET /api/schema.json` and works out the enclosing type by tracking braces rather than parsing, which
is enough for ordinary queries and gives up on fragments, directives and inline spreads.

## Two things worth knowing about the API

- **The token endpoint answers `200 OK` even when it rejects the grant.** A failure comes back as
  `{ "error_descriptions": … }` with a 200 status, so check for the presence of `access_token`
  rather than the status code. `src/luca.js` does this in `tokenRequest`.
- **`expires_in` is a string**, not a number (`"3600"`). Coerce it before doing arithmetic.

## A note on `state`

The OAuth2 spec's `state` parameter lets a client tie a callback back to the request that started
it, and protects the authorization step against CSRF. Luca's authorize endpoint does not currently
accept a `state` parameter and does not echo one back on the callback, so this example does not
send one. If you are building a production integration, check whether that has changed.

## Security notes

This is a local development sample, not a hardened application:

- Credentials and tokens live in the server's memory for the length of your browser session and are
  never written to disk. Restarting the server forgets them.
- Sessions use the default `express-session` memory store, which is single-process and not meant
  for production.
- The page prints your access and refresh tokens in full — that is the point of the demo, but do
  not run it on a shared or public host.
- Its own forms carry no CSRF token; they rely on a `SameSite=Lax` session cookie.
- Never commit a `.env` containing real credentials.

## Licence

MIT — see [LICENSE](LICENSE).
