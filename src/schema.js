// GraphQL introspection: asking the Luca API to describe itself.
//
// Every GraphQL API answers a special `__schema` query listing its own types
// and fields, which is where the sidebar on the API page comes from — nothing
// about Luca's schema is hardcoded here.

import { graphql } from "./luca.js";

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
          args { name type { ...Ref } }
          type { ...Ref }
        }
      }
    }
  }

  fragment Ref on __Type {
    kind
    name
    ofType { kind name ofType { kind name ofType { kind name } } }
  }
`;

// Keyed by session as well as host: what introspection returns depends on the
// grant behind the token, so one session must never be served another's schema.
const cache = new Map();
const MAX_ENTRIES = 20;

const keyFor = (sessionId, host) => `${sessionId}\u0000${host}`;

export function forget(sessionId, host) {
  cache.delete(keyFor(sessionId, host));
}

export async function load({ sessionId, host, accessToken }) {
  const key = keyFor(sessionId, host);
  if (cache.has(key)) return cache.get(key);

  const { body } = await graphql({ host, accessToken, query: INTROSPECTION_QUERY });

  if (body.errors) {
    const [first] = body.errors;
    throw new Error(first?.message ?? "Introspection was refused by the API.");
  }

  const schema = summarize(body.data.__schema);
  remember(key, schema);

  return schema;
}

function remember(key, schema) {
  cache.set(key, schema);

  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

export function summarize(introspected) {
  const types = new Map(
    introspected.types
      .filter((type) => type.name && !type.name.startsWith("__"))
      .map((type) => [type.name, { ...type, fields: (type.fields ?? []).map(distillField) }]),
  );

  return {
    queries: fieldsOf(introspected.queryType, types, "query"),
    mutations: fieldsOf(introspected.mutationType, types, "mutation"),
    types,
  };
}

function fieldsOf(root, types, operation) {
  if (!root) return [];

  return (types.get(root.name)?.fields ?? [])
    .map((field) => ({ ...field, operation }))
    .sort(byName);
}

function distillField(field) {
  return {
    name: field.name,
    description: field.description ?? "",
    returns: render(field.type),
    args: (field.args ?? []).map((arg) => ({
      name: arg.name,
      type: render(arg.type),
      required: arg.type?.kind === "NON_NULL",
    })),
    typeName: unwrap(field.type),
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

// A runnable example for one field. Required arguments become $variables
// rather than literals, because GraphQL rejects a null for a NON_NULL argument
// outright — a literal would fail validation before Luca ever saw it.
export function starterQuery(field, types) {
  const args = field.args.filter((arg) => arg.required);
  const call = args.length ? `(${args.map((arg) => `${arg.name}: $${arg.name}`).join(", ")})` : "";
  const params = args.length ? ` (${args.map((arg) => `$${arg.name}: ${arg.type}`).join(", ")})` : "";

  // A plain `{ … }` is already a query operation; a mutation field has to say so.
  const header = params || field.operation === "mutation" ? `${field.operation}${params} ` : "";

  return `${header}{\n  ${field.name}${call}${selection(field.typeName, types, 2, 1)}\n}`;
}

export function starterVariables(field) {
  const args = field.args.filter((arg) => arg.required);
  if (!args.length) return "";

  return JSON.stringify(
    Object.fromEntries(args.map((arg) => [arg.name, placeholder(arg.type)])),
    null,
    2,
  );
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

const byName = (a, b) => a.name.localeCompare(b.name);
