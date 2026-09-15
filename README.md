# Luca API example

A small Express app for connecting to the [Luca](https://go.lucaregnskap.no) accounting API:
the **OAuth 2.1** authorization-code flow with PKCE, end to end — discover the endpoints, grant
access, get redirected back, exchange the code for tokens, refresh them, revoke them — and then a
page for exploring the GraphQL API with the token you just got.

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
| 0. Discover | Server → `GET {host}/.well-known/oauth-authorization-server` — every endpoint below comes from here |
| 1. Authorize | Browser → `GET {authorization_endpoint}?client_id&response_type=code&redirect_uri&scope&state&code_challenge&code_challenge_method=S256` |
| 2. Callback | Luca → `{redirect_uri}?code=…&state=…&iss=…` |
| 3. Exchange | Server → `POST {token_endpoint}` with `grant_type=authorization_code` and the matching `code_verifier` |
| 4. Refresh | Server → same endpoint with `grant_type=refresh_token`; both tokens rotate |
| 5. Use it | Server → `POST {resource}` with `Authorization: Bearer <access_token>` and a `companyId` on every field |
| 6. Revoke | Server → `POST {revocation_endpoint}` when you disconnect |

Steps 3–6 are server-to-server. For a confidential client that means the client secret never
reaches the browser; a public client has no secret at all and relies on PKCE instead.

## Before you start

You need an OAuth application registered in Luca, with:

- **Redirect URI** — `http://localhost:8080/oauth/callback`, exactly. Luca compares it character
  for character against what you registered, so if you change the port, change the registration too.
- **Client ID** — paste it into the form on the page.
- **Client secret** — for a confidential client. Leave it blank to run as a **public** client, which
  sends no secret and is identified by PKCE alone. Luca shows the secret once, when the application
  is created, and never again.
- **Scopes** — the application must be registered for whatever you ask for. Requesting a scope it
  does not have is refused with `invalid_scope`.

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
| `src/discovery.js` | Reads the host's OAuth metadata documents, and remembers them |
| `src/schema.js` | What the token can see: the schema, the companies, and example queries |
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
| `HOST` | `https://go.lucaregnskap.no` | The Luca instance to talk to. Only the host — the endpoints are discovered |
| `CLIENT_ID` | — | Prefills the form |
| `CLIENT_SECRET` | — | Prefills the form. Blank means a public client |
| `SCOPE` | `accounting.read` | Space-separated scopes to request |
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
→ POST https://go.lucaregnskap.no/oauth/token
  grant_type=authorization_code  code=«redacted, 43 chars»  redirect_uri=http://localhost:8080/oauth/callback  client_id=6d0f…  client_secret=«redacted, 43 chars»  code_verifier=«redacted, 43 chars»
← 200 in 412ms
  access_token=«redacted, 43 chars»  refresh_token=«redacted, 43 chars»  token_type=Bearer  expires_in=3600  scope=accounting.read
```

Secrets are replaced with `«redacted»`, keeping their length so you can still tell that something
came back, and a GraphQL reply's `data` is summarised as a size rather than printed — it is your
accounting data, and these logs end up in screenshots. Everything else — grant type, redirect URI,
client ID, timings, GraphQL `errors`, error descriptions — is printed in full, which is usually
what you need when a handshake fails. `state`, `code_challenge`, `scope` and `iss` are deliberately
left visible: watching `state` go out and come back is half the point of reading these. The logs are
safe to paste into an issue.

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

Two different things can make an argument required. A `NON_NULL` type is required by the *schema*,
and GraphQL itself refuses a document without it. `companyId` is required by the *token* — the
schema declares it nullable, because a personal API key is bound to one company and may leave it
out, but an OAuth access token reaches several and has to say which. Generated examples fill in
both.

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

### Companies and `companyId`

An OAuth access token reaches every company the user ticked on Luca's consent screen, so every
query and mutation takes a **`companyId`** naming which one that field is about. It accepts the
company's id or its organisation number.

The sidebar lists the companies your token covers, and the one you pick is what **Try it** writes
into the generated example. Two fields need no `companyId`, because their job is to tell you which
companies you may reach: `companies` lists them — it is the query the page opens with — and
`company(id: …)` looks one up.

Because the company is named per field rather than per request, one document can ask about several
at once, which the page offers as a one-click example when your token covers more than one:

```graphql
{
  first:  saleInvoices(companyId: "987654321") { nodes { id } }
  second: saleInvoices(companyId: "123456789") { nodes { id } }
}
```

A field that names no company, or one outside the consent, comes back as a GraphQL field error
while the rest of the document still resolves — so a response can carry `data` and `errors`
together, which the page labels `partial` rather than treating as a failure.

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

## Things worth knowing about the API

- **Do not hardcode the endpoints.** Read them from
  `{host}/.well-known/oauth-authorization-server`. The same Luca codebase is served under several
  brands on several hosts, and each one names its own; discovery is what makes one integration work
  against all of them.
- **PKCE is required, `S256` only.** There is no flow without it, for confidential and public
  clients alike.
- **Access tokens are opaque** — no longer a JWT, and there is nothing to decode. They last an hour.
  Ask the introspection endpoint if you need to know what one carries.
- **Refresh tokens rotate.** Every refresh returns a new one and kills the old, so store the new
  value each time. Presenting a spent refresh token is treated as theft and revokes the whole
  authorization — the user has to authorize again.
- **Read the granted scope from the token response**, not from what you asked for. It can come back
  narrower.
- **A confidential client must authenticate on every token endpoint call** — the exchange, the
  refresh *and* the revocation. Sending only `client_id` to `/oauth/token` answers
  `401 invalid_client`, and to `/oauth/revoke` answers `403` while leaving the token alive.
- **Every query and mutation needs a `companyId`** except `companies` and `company(id:)`.
- **The field errors are not machine-readable.** `companyId is required`, `is not one of` and the
  read-only refusal arrive as plain GraphQL field errors with no `extensions.code`, *and* they are
  translated into the language of the Luca user who granted the token — which the client does not
  choose. `src/luca.js` matches a phrase from each language in `explain`, and says why that is a bad
  habit worth replacing the moment there is a code to match on.
- **Ask for `Accept: application/json`.** Without it `POST /api/v1/graphql` labels its JSON body
  `Content-Type: text/html`.

## `state`, PKCE and `iss`

Three separate defences, all of which this example uses and none of which are optional:

- **`state`** is a random value sent to `/authorize` and echoed back on the callback. It ties a
  callback to the request that started it: a callback whose `state` does not match one this app
  generated is refused *before* the code is redeemed, which is what stops someone else's
  authorization code being planted in your session.
- **PKCE** sends `code_challenge`, the SHA-256 of a `code_verifier` that never leaves this server —
  the browser only carries the hash. Whoever intercepts the authorization code cannot spend it
  without the verifier. It is what lets a public client exist at all.
- **`iss`** (RFC 9207) names the authorization server that produced the response. A client that
  talks to more than one Luca host checks it before redeeming the code, so one host's code cannot
  be redeemed at another.

The verifier and the state live in the server-side session for the length of one authorization, in
`req.session.pending`, and `src/routes/oauth.js` clears them on every path out of the callback —
success or failure — because a code verifier is single-use.

## Security notes

This is a local development sample, not a hardened application:

- Credentials and tokens live in the server's memory for the length of your browser session and are
  never written to disk. Restarting the server forgets them.
- Sessions use the default `express-session` memory store, which is single-process and not meant
  for production.
- The page prints your access and refresh tokens in full — that is the point of the demo, but do
  not run it on a shared or public host.
- Its own forms carry no CSRF token; they rely on a `SameSite=Lax` session cookie.
- When the metadata document cannot be read, this example guesses Luca's usual endpoint paths and
  says so loudly on the page. That is a teaching convenience so a proxy or a certificate problem
  does not end the tutorial — a production client should fail closed, or ship endpoints pinned at
  build time. Half-trusting a document you could not read is how a client ends up posting its
  secret somewhere unexpected.
- Never commit a `.env` containing real credentials.

## Licence

MIT.
