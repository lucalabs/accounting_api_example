const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

export function json(text) {
  const source = String(text ?? "");
  let out = "";
  let last = 0;

  for (const match of source.matchAll(TOKEN)) {
    out += escapeHtml(source.slice(last, match.index));
    out += span(match);
    last = match.index + match[0].length;
  }

  return out + escapeHtml(source.slice(last));
}

function span(match) {
  const [, key, colon, string, literal, number] = match;

  if (key) return `<span class="t-key">${escapeHtml(key)}</span>${escapeHtml(colon)}`;
  if (string) return `<span class="t-string">${escapeHtml(string)}</span>`;
  if (literal) return `<span class="t-literal">${escapeHtml(literal)}</span>`;
  if (number) return `<span class="t-number">${escapeHtml(number)}</span>`;

  return escapeHtml(match[0]);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
