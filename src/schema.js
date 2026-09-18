// What this token can see: the API's own description of itself, and the
// companies the token may reach.
//
// Every GraphQL API answers a special `__schema` query listing its own types
// and fields, which is where the sidebar on the API page comes from — nothing
// about Luca's schema is hardcoded here.
//
// The companies live here too rather than in a file of their own. Both are
// answers to "what does this access token open?", both are fetched with it,
// and both stop being true the moment the grant behind it changes — so they
// share one cache, one lifetime and one place to forget.

import { DEFAULT_QUERY, explain, graphql } from "./luca.js";

// The argument every root field takes, naming which of the authorized
// companies that field is about. It accepts a company id or an organisation
// number.
export const COMPANY_ARG = "companyId";

// The only two fields that do not need one, because their job is to tell a
// client which companies it may reach — they cannot themselves demand the
// answer. Both accept `companyId` like everything else; they just do not
// require it. This is a property of the grant rather than of the schema, which
// is why it is two names written down here and not something introspection can
// be asked for.
const COMPANY_FIELDS = new Set(["companies", "company"]);

// The query the app runs to learn which companies a token reaches — the very
// same one sitting in the editor when the API page opens, so pressing Send
// shows you the app's own homework.
export const COMPANIES_QUERY = DEFAULT_QUERY;

export const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        description
        fields(includeDeprecated: false) {
          name
          description
          args { ...Input }
          type { ...Ref }
        }
        inputFields { ...Input }
        enumValues(includeDeprecated: false) { name description }
        interfaces { ...Ref }
        possibleTypes { ...Ref }
      }
    }
  }

  fragment Input on __InputValue {
    name
    description
    defaultValue
    type { ...Ref }
  }

  fragment Ref on __Type {
    kind
    name
    ofType { kind name ofType { kind name ofType { kind name } } }
  }
`;

// Keyed by session as well as host: what introspection returns — and which
// companies come back — depends on the grant behind the token, so one session
// must never be served another's answers.
const cache = new Map();
const MAX_ENTRIES = 20;

const keyFor = (sessionId, host, kind) => `${sessionId}\u0000${host}\u0000${kind}`;

// Drops both halves, so the Reload link on the API page and a reconnect in
// src/routes/oauth.js each get a clean slate.
export function forget(sessionId, host) {
  for (const kind of ["schema", "companies"]) cache.delete(keyFor(sessionId, host, kind));
}

export async function load({ sessionId, host, accessToken }) {
  const key = keyFor(sessionId, host, "schema");
  if (cache.has(key)) return cache.get(key);

  const { status, body } = await graphql({ host, accessToken, query: INTROSPECTION_QUERY });

  if (body.errors) throw refusal(status, body, "Introspection was refused by the API.");

  const schema = summarize(body.data.__schema);
  remember(key, schema);

  return schema;
}

// The companies this token may name. Fetched with the same token, cached
// beside the schema, and thrown away with it.
export async function loadCompanies({ sessionId, host, accessToken }) {
  const key = keyFor(sessionId, host, "companies");
  if (cache.has(key)) return cache.get(key);

  const { status, body } = await graphql({ host, accessToken, query: COMPANIES_QUERY });

  if (body.errors) throw refusal(status, body, "The API refused to list companies.");

  const companies = body.data?.companies?.nodes ?? [];
  remember(key, companies);

  return companies;
}

// `explain` turns the API's own rules into a sentence worth reading; without
// it a 401 surfaces here as the bare word "Unauthorized".
function refusal(status, body, fallback) {
  const [first] = body.errors ?? [];

  return new Error(explain({ status, body }) ?? first?.message ?? fallback);
}

function remember(key, schema) {
  cache.set(key, schema);

  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

export function summarize(introspected) {
  const types = new Map(
    introspected.types
      .filter((type) => type.name && !type.name.startsWith("__"))
      .map((type) => [type.name, distillType(type)]),
  );

  const roots = {
    query: introspected.queryType?.name ?? null,
    mutation: introspected.mutationType?.name ?? null,
  };

  return {
    roots,
    queries: fieldsOf(roots.query, types, "query"),
    mutations: fieldsOf(roots.mutation, types, "mutation"),
    types,
  };
}

// One shape for every kind of type, so a template can ask any of them for its
// fields without checking what it is first. Only one or two of these lists are
// ever filled in: objects have `fields`, inputs have `inputFields`, enums have
// `enumValues`, unions have `possibleTypes`, and scalars have none of them.
function distillType(type) {
  return {
    kind: type.kind,
    name: type.name,
    description: type.description ?? "",
    fields: (type.fields ?? []).map(distillField),
    inputFields: (type.inputFields ?? []).map(distillInput),
    enumValues: (type.enumValues ?? []).map((value) => ({
      name: value.name,
      description: value.description ?? "",
    })),
    interfaces: (type.interfaces ?? []).map(unwrap).filter(Boolean),
    possibleTypes: (type.possibleTypes ?? []).map(unwrap).filter(Boolean),
  };
}

function fieldsOf(rootName, types, operation) {
  if (!rootName) return [];

  return (types.get(rootName)?.fields ?? [])
    .map((field) => ({ ...field, operation }))
    .sort(byName);
}

function distillField(field) {
  return {
    name: field.name,
    description: field.description ?? "",
    returns: render(field.type),
    args: (field.args ?? []).map(distillInput),
    typeName: unwrap(field.type),
  };
}

// An argument and an input-object field are both `__InputValue` in the schema,
// so one function covers the arguments in a signature and the fields you fill
// in to build a mutation's input.
//
// `required` here means *required by the schema* — a NON_NULL type, which
// GraphQL itself will not let you leave out. It is not the only way an
// argument can be mandatory: see needsCompany below.
function distillInput(input) {
  return {
    name: input.name,
    description: input.description ?? "",
    type: render(input.type),
    required: input.type?.kind === "NON_NULL",
    defaultValue: input.defaultValue ?? null,
    typeName: unwrap(input.type),
  };
}

export function render(type) {
  if (!type) return "";
  if (type.kind === "NON_NULL") return `${render(type.ofType)}!`;
  if (type.kind === "LIST") return `[${render(type.ofType)}]`;

  return type.name ?? "";
}

function unwrap(type) {
  return type?.name ? type.name : type?.ofType ? unwrap(type.ofType) : null;
}

// Does this field need a `companyId` even though the schema says it is
// optional? The schema declares it nullable on purpose — a personal API key is
// bound to one company and may leave it out — but an OAuth access token
// reaches several, so for one of those it is required at run time on every
// field but the two exempt ones.
export function needsCompany(field) {
  return !COMPANY_FIELDS.has(field.name) && field.args.some((arg) => arg.name === COMPANY_ARG);
}

// The arguments a generated example should fill in, and the single place the
// query and its variables agree on that list. Two different kinds of required
// meet here: NON_NULL, which GraphQL enforces, and `companyId`, which the
// access token enforces.
export function exampleArgs(field) {
  const required = field.args.filter((arg) => arg.required && arg.name !== COMPANY_ARG);
  const company = needsCompany(field) ? field.args.filter((arg) => arg.name === COMPANY_ARG) : [];

  return [...company, ...required];
}

// A runnable example for one field. Arguments become $variables rather than
// literals: GraphQL rejects a null for a NON_NULL argument outright, so a
// literal would fail validation before Luca ever saw it.
//
// `companyId` is declared in the example exactly as the schema declares it —
// `$companyId: ID`, nullable — and filled in with a real company. That it
// passes validation either way, and is enforced later by the token, is the
// whole shape of the new model in one line.
export function starterQuery(field, types, { companyId } = {}) {
  const args = exampleArgs(field);
  const call = args.length ? `(${args.map((arg) => `${arg.name}: $${arg.name}`).join(", ")})` : "";
  const params = args.length ? ` (${args.map((arg) => `$${arg.name}: ${arg.type}`).join(", ")})` : "";

  // A plain `{ … }` is already a query operation; a mutation field has to say so.
  const header = params || field.operation === "mutation" ? `${field.operation}${params} ` : "";

  return `${header}{\n  ${field.name}${call}${selection(field.typeName, types, 2, 1)}\n}`;
}

export function starterVariables(field, { companyId } = {}) {
  const args = exampleArgs(field);
  if (!args.length) return "";

  return JSON.stringify(
    Object.fromEntries(
      args.map((arg) => [
        arg.name,
        arg.name === COMPANY_ARG ? (companyId ?? "") : placeholder(arg.type),
      ]),
    ),
    null,
    2,
  );
}

// Swapping the company in the variables the editor already holds, so picking a
// different one does not throw away the query you were writing. A JSON body
// without a `companyId` is handed back untouched.
export function applyCompany(variablesJson, companyId) {
  const text = String(variablesJson ?? "");
  if (!text.trim()) return text;

  try {
    const parsed = JSON.parse(text);
    if (!Object.hasOwn(parsed, COMPANY_ARG)) return text;

    return JSON.stringify({ ...parsed, [COMPANY_ARG]: companyId }, null, 2);
  } catch {
    return text;
  }
}

// The one thing the new model makes possible that the old one did not: because
// the company is named per field and not per request, a single document can
// ask about several at once.
//
// Literals rather than $variables here, deliberately — the point is to see two
// different ids side by side. Two selections of the same field also need
// aliases to coexist, so the example teaches that in passing.
export function everyCompanyQuery(field, types, companies) {
  const body = companies
    .map((company, index) => {
      const call = `(${COMPANY_ARG}: ${JSON.stringify(company.id)})`;

      return `  ${aliasFor(company, index, companies)}: ${field.name}${call}${selection(field.typeName, types, 2, 1)}`;
    })
    .join("\n");

  return `${field.operation === "mutation" ? "mutation " : ""}{\n${body}\n}`;
}

// An organisation number cannot be an alias — GraphQL names may not start with
// a digit — so this works from the company name, and gives up on a positional
// name when that leaves nothing usable or duplicated.
function aliasFor(company, index, companies) {
  const cleaned = String(company.name ?? "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/^[0-9]+/, "");
  const unique = cleaned && companies.filter((other) => sameAlias(other, cleaned)).length === 1;

  return unique ? cleaned.slice(0, 40) : `company${index + 1}`;
}

function sameAlias(company, cleaned) {
  return String(company.name ?? "").replace(/[^A-Za-z0-9_]/g, "").replace(/^[0-9]+/, "") === cleaned;
}

function placeholder(type) {
  if (type.startsWith("[")) return [];

  switch (type.replace(/!$/, "")) {
    case "Int":
    case "Float":
      return 0;
    case "Boolean":
      return false;
    case "ID":
    case "String":
      return "";
    default:
      return null;
  }
}

// Luca's list fields are connection-shaped, so stepping into `nodes` is what
// turns an example into one that returns something.
//
// Unaffected by `companyId`: this only ever walks *into* a field's own type,
// never across the root, and everything below a root field is already scoped by
// the company that field named.
const WORTH_EXPANDING = new Set(["nodes", "edges", "node"]);
const MAX_FIELDS = 6;

function selection(typeName, types, depth, indent) {
  const type = types.get(typeName);
  if (!type?.fields?.length) return "";
  if (depth === 0) return " { __typename }";

  const picked = [];

  for (const field of type.fields) {
    if (picked.length >= MAX_FIELDS) break;
    if (field.args.some((arg) => arg.required)) continue;

    const isLeaf = !types.get(field.typeName)?.fields?.length;

    if (isLeaf) picked.push(field.name);
    else if (WORTH_EXPANDING.has(field.name)) {
      picked.push(field.name + selection(field.typeName, types, depth - 1, indent + 1));
    }
  }

  if (!picked.length) picked.push("__typename");

  const pad = "  ".repeat(indent + 1);
  return ` {\n${picked.map((line) => pad + line).join("\n")}\n${"  ".repeat(indent)}}`;
}

export function filter(schema, term) {
  const needle = String(term ?? "").trim().toLowerCase();
  if (!schema || !needle) return schema;

  const matches = (field) =>
    field.name.toLowerCase().includes(needle) ||
    field.description.toLowerCase().includes(needle);

  return {
    ...schema,
    queries: schema.queries.filter(matches),
    mutations: schema.mutations.filter(matches),
  };
}

export function find(schema, name) {
  if (!schema || !name) return null;

  return [...schema.queries, ...schema.mutations].find((field) => field.name === name) ?? null;
}

export function findType(schema, name) {
  if (!schema || !name) return null;

  return schema.types.get(name) ?? null;
}

// The trimmed-down schema the editor's autocomplete needs in the browser: for
// every type, the fields you can write inside it and the type each one leads
// to. That is enough to answer "what is valid where the cursor is?" without
// shipping a GraphQL parser. Descriptions are cut to a single line — the full
// ones are one click away in the sidebar.
const HINT_LENGTH = 90;

export function outline(schema) {
  const types = {};

  for (const [name, type] of schema.types) {
    if (!type.fields.length) continue;

    types[name] = type.fields.map((field) => ({
      name: field.name,
      type: field.typeName,
      returns: field.returns,
      hint: shorten(field.description),
    }));
  }

  return { roots: schema.roots, types };
}

function shorten(text) {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length > HINT_LENGTH ? `${line.slice(0, HINT_LENGTH - 1)}…` : line;
}

const byName = (a, b) => a.name.localeCompare(b.name);
