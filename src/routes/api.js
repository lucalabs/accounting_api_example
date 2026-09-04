import { Router } from "express";

import * as luca from "../luca.js";
import * as schemas from "../schema.js";
import * as highlight from "../highlight.js";
import { requireToken } from "../guards.js";

const router = Router();

router.get("/api", requireToken, async (req, res) => {
  const state = await load(req);
  const chosen = schemas.find(state.schema, req.query.field);

  render(res, {
    ...state,
    query:
      req.query.query ??
      (chosen ? schemas.starterQuery(chosen, state.schema.types) : luca.DEFAULT_QUERY),
    variables: req.query.variables ?? (chosen ? schemas.starterVariables(chosen) : ""),
  });
});

// What the editor's autocomplete reads. Served separately rather than inlined
// into the page so a large schema is fetched once, in the background, and the
// editor keeps working if it never arrives.
router.get("/api/schema.json", requireToken, async (req, res) => {
  const { schema, schemaError } = await load(req);

  if (!schema) return res.status(502).json({ error: schemaError });

  res.json(schemas.outline(schema));
});

router.post("/api/query", requireToken, async (req, res) => {
  const state = await load(req);
  const query = req.body.query || luca.DEFAULT_QUERY;
  const variables = req.body.variables ?? "";
  const page = { ...state, query, variables };

  let parsed;

  try {
    parsed = variables.trim() ? JSON.parse(variables) : undefined;
  } catch (error) {
    return render(res, {
      ...page,
      result: { ok: false, label: "Invalid variables", body: `Variables must be valid JSON.\n${error.message}` },
      flash: { type: "alert", message: "Variables are not valid JSON." },
    });
  }

  try {
    const { status, ms, body } = await luca.graphql({
      ...req.credentials,
      accessToken: req.session.token.access_token,
      query,
      variables: parsed,
    });

    // GraphQL reports its own failures in an `errors` array, usually with a
    // 200, so both need checking.
    const ok = status < 400 && !body.errors;

    render(res, {
      ...page,
      result: { ok, label: `${status} · ${ms}ms`, body: JSON.stringify(body, null, 2) },
      flash: {
        type: ok ? "notice" : "alert",
        message: ok ? "Query succeeded." : "The API returned errors.",
      },
    });
  } catch (error) {
    render(res, {
      ...page,
      result: { ok: false, label: "Failed", body: luca.describeError(error) },
      flash: { type: "alert", message: "Query failed." },
    });
  }
});

// Introspection needs a working token, so a failure here is shown on the page
// rather than thrown.
async function load(req) {
  const host = luca.normalizeHost(req.credentials.host);
  const search = req.query.q ?? req.body?.q ?? "";

  if (req.query.refresh) schemas.forget(req.sessionID, host);

  let schema = null;
  let schemaError = null;

  try {
    schema = await schemas.load({
      sessionId: req.sessionID,
      host,
      accessToken: req.session.token.access_token,
    });
  } catch (error) {
    schemaError = luca.describeError(error);
  }

  return {
    schema,
    filtered: schema && schemas.filter(schema, search),
    type: schemas.findType(schema, req.query.type ?? req.body?.type),
    search,
    schemaError,
  };
}

function render(res, locals) {
  res.render("layout", {
    page: "pages/api",
    title: "API",
    wide: true,
    result: null,
    type: null,
    highlight,
    ...locals,
  });
}

export default router;
