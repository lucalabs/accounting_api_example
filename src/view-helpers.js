import { escapeHtml } from "./highlight.js";

export function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-GB", { hour12: false });
}

export function humanizeSeconds(total) {
  if (total < 60) return `${total}s`;

  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function tokenTiming(token) {
  const obtainedAt = new Date(token.obtained_at);
  const expiresAt = new Date(obtainedAt.getTime() + token.expires_in * 1000);
  const secondsLeft = Math.round((expiresAt - Date.now()) / 1000);

  return { obtainedAt, expiresAt, secondsLeft, expired: secondsLeft <= 0 };
}

// A field's type as it appears in a signature — `[Company!]!`, say — with the
// named type inside the list and non-null punctuation linked to its own entry
// in the sidebar. `linkable` is false for scalars the schema does not describe,
// which would otherwise be dead links.
export function typeRef({ rendered, typeName, linkable, state }) {
  // `rendered` is the name wrapped in list and non-null punctuation, so the
  // bare name appears in it exactly once and the rest is `[`, `]` and `!`.
  const at = typeName ? rendered.indexOf(typeName) : -1;

  if (!linkable || at < 0) return `<span class="t-type">${escapeHtml(rendered)}</span>`;

  const href = escapeHtml(`/api?${new URLSearchParams({ ...state, type: typeName })}`);
  const before = escapeHtml(rendered.slice(0, at));
  const after = escapeHtml(rendered.slice(at + typeName.length));

  return `<span class="t-type">${before}<a class="t-link" href="${href}">${escapeHtml(typeName)}</a>${after}</span>`;
}
