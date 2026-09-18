import { Router } from "express";

import * as luca from "../luca.js";
import * as discovery from "../discovery.js";
import * as schemas from "../schema.js";
import * as highlight from "../highlight.js";
import { requireToken } from "../guards.js";

const router = Router();

router.get("/api", requireToken, async (req, res) => {
  const state = await load(req);
  const chosen = schemas.find(state.schema, req.query.field);
  const companyId = state.company?.id;

  render(res, {
    ...state,
    field: chosen ? chosen.name : "",
    query: startingQuery(req, state, chosen, companyId),
    variables: startingVariables(req, state, chosen, companyId),
  });
});

function startingQuery(req, state, chosen, companyId) {
  if (!chosen) return req.query.query ?? luca.DEFAULT_QUERY;

  // `all` is the "ask every company at once" link: one document, one field per
  // company, which only exists as an option with more than one to name.
  if (req.query.all && state.companies.length > 1) {
    return schemas.everyCompanyQuery(chosen, state.schema.types, state.companies);
  }

  return req.query.query ?? schemas.starterQuery(chosen, state.schema.types, { companyId });
}

function startingVariables(req, state, chosen, companyId) {
  if (req.query.all) return "";

  // Only a click on the company picker rewrites variables the user may have
  // edited. Every other link carries `company` along untouched, because reading
  // the docs must not cost you the query you were writing.
  //
  // Checked before `chosen`, because swapping a company in variables that are
  // already there needs no field — and the picker's links do not name one.
  if (req.query.pick && req.query.variables !== undefined) {
    return schemas.applyCompany(req.query.variables, companyId);
  }

  if (!chosen) return req.query.variables ?? "";

  return req.query.variables ?? schemas.starterVariables(chosen, { companyId });
}

// What the editor's autocomplete reads. Served separately rather than inlined
// into the page so a large schema is fetched once, in the background, and the
// editor keeps working if it never arrives.
router.get("/api/schema.json", requireToken, async (req, res) => {
  const { schema, schemaError } = await load(req, { companies: false, resource: false });

  if (!schema) return res.status(502).json({ error: schemaError });

  res.json(schemas.outline(schema));
});

router.post("/api/query", requireToken, async (req, res) => {
  const state = await load(req);
  const query = req.body.query || luca.DEFAULT_QUERY;
  const variables = req.body.variables ?? "";
  const page = { ...state, field: req.body.field ?? "", query, variables };

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
    const { status, ms, body, challenge } = await luca.graphql({
      host: req.credentials.host,
      endpoint: state.resource?.resource,
      accessToken: req.session.token.access_token,
      query,
      variables: parsed,
    });

    // GraphQL reports its own failures in an `errors` array, usually with a
    // 200, so both need checking. A field error can now also sit beside
    // perfectly good data: name two companies in one document and get one
    // wrong, and the good half still resolves. That is the model working, not
    // a malfunction — so it is labelled apart from an outright failure.
    const failed = Boolean(body.errors);
    const ok = status < 400 && !failed;
    const partial = failed && Boolean(body.data);

    render(res, {
      ...page,
      result: {
        ok,
        label: partial ? `${status} · partial` : `${status} · ${ms}ms`,
        body: JSON.stringify(body, null, 2),
        explanation: ok ? null : luca.explain({ status, body }),
        challenge: challenge ?? null,
      },
      flash: {
        type: ok ? "notice" : "alert",
        message: ok
          ? "Query succeeded."
          : partial
            ? "Part of the document resolved; the rest returned errors."
            : "The API returned errors.",
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

// Introspection and the company list both need a working token, so a failure
// in either is shown on the page rather than thrown.
async function load(req, { companies = true, resource: wantResource = true } = {}) {
  const host = luca.normalizeHost(req.credentials.host);
  const search = req.query.q ?? req.body?.q ?? "";
  const wanted = req.query.company ?? req.body?.company ?? "";

  if (req.query.refresh) schemas.forget(req.sessionID, host);

  const accessToken = req.session.token.access_token;
  const attempt = (work) => work.then((value) => [value, null], (error) => [null, luca.describeError(error)]);

  const [[schema, schemaError], [reached, companiesError], resource] = await Promise.all([
    attempt(schemas.load({ sessionId: req.sessionID, host, accessToken })),
    companies
      ? attempt(schemas.loadCompanies({ sessionId: req.sessionID, host, accessToken }))
      : [[], null],
    wantResource ? discovery.discoverResource(host) : null,
  ]);

  return {
    schema,
    filtered: schema && schemas.filter(schema, search),
    type: schemas.findType(schema, req.query.type ?? req.body?.type),
    search,
    schemaError,
    companies: reached ?? [],
    company: pickCompany(reached ?? [], wanted),
    companiesError,
    resource,
  };
}

// `companyId` accepts either form, so the picker does too — a link carries the
// id, but a value hand-typed as an organisation number still selects the right
// row instead of silently falling back to the first.
function pickCompany(companies, wanted) {
  if (!companies.length) return null;

  return (
    companies.find(
      (company) => company.id === wanted || company.organisationNumber === wanted,
    ) ?? companies[0]
  );
}

function render(res, locals) {
  res.render("layout", {
    page: "pages/api",
    title: "API",
    wide: true,
    result: null,
    type: null,
    field: "",
    highlight,
    ...locals,
  });
}

export default router;
