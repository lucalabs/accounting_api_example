// Field-name autocomplete for the query editor.
//
// This file is an enhancement and nothing depends on it: the editor is a plain
// <textarea> in a form that posts to the server, so with JavaScript off you
// type field names yourself and everything still works. What it adds is the
// one thing a server round-trip cannot — knowing which fields are valid at the
// cursor, while you are still typing.
//
// It answers that by scanning the text before the caret rather than parsing
// it. A GraphQL selection set nests with braces, so remembering the field name
// in front of each `{` gives the path from the root, and walking that path
// through the schema gives the type whose fields belong here. That is a few
// dozen lines instead of a parser, and it is wrong only in corners this page
// does not reach for: fragments, directives and inline spreads.

const editor = document.getElementById("query");
const source = editor?.dataset.complete;

const IDENTIFIER = /[_A-Za-z][_0-9A-Za-z]*/y;
const TRAILING_WORD = /[_A-Za-z][_0-9A-Za-z]*$/;
const MAX_SUGGESTIONS = 12;

let outline = null;

if (editor && source) {
  fetch(source, { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => {
      if (!body?.types) return;

      outline = body;
      attach(editor);
    })
    // No schema, no autocomplete. The editor is unaffected either way, so
    // there is nothing worth interrupting anyone about.
    .catch(() => {});
}

function attach(editor) {
  const popup = document.createElement("ul");

  popup.className = "complete";
  popup.hidden = true;
  editor.form.append(popup);

  let items = [];
  let prefix = "";
  let active = 0;

  function close() {
    popup.hidden = true;
    items = [];
  }

  // `force` is the Ctrl-Space case: list everything valid here, even though
  // nothing has been typed to narrow it down.
  function open(force) {
    const before = editor.value.slice(0, editor.selectionStart);
    const found = suggest(before);

    if (!found.items.length || (!found.prefix && !force)) return close();

    ({ items, prefix } = found);
    active = 0;

    popup.replaceChildren(...items.map(row));
    popup.hidden = false;
    mark();
    place(editor, popup);
  }

  function mark() {
    popup.querySelectorAll("li").forEach((li, index) => {
      li.classList.toggle("on", index === active);
    });

    popup.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function move(step) {
    active = (active + step + items.length) % items.length;
    mark();
  }

  function accept() {
    const field = items[active];
    if (!field) return;

    const at = editor.selectionStart;

    editor.setRangeText(field.name, at - prefix.length, at, "end");
    close();
  }

  editor.addEventListener("input", () => open(false));
  editor.addEventListener("blur", close);
  editor.addEventListener("scroll", close);
  editor.addEventListener("click", close);

  editor.addEventListener("keydown", (event) => {
    if (popup.hidden) {
      if (event.key === " " && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        open(true);
      }

      return;
    }

    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Enter":
      case "Tab":
        accept();
        break;
      case "Escape":
        close();
        break;
      default:
        return;
    }

    event.preventDefault();
  });

  // mousedown rather than click: it fires before the textarea loses focus, so
  // the blur handler does not close the list out from under the pointer.
  popup.addEventListener("mousedown", (event) => {
    const li = event.target.closest("li");
    if (!li) return;

    event.preventDefault();
    active = [...popup.children].indexOf(li);
    accept();
  });
}

function row(field) {
  const li = document.createElement("li");
  const name = document.createElement("span");
  const type = document.createElement("span");

  name.className = "c-name";
  name.textContent = field.name;
  type.className = "c-type";
  type.textContent = field.returns;
  li.append(name, type);

  if (field.hint) {
    const hint = document.createElement("p");

    hint.className = "c-hint";
    hint.textContent = field.hint;
    li.append(hint);
  }

  return li;
}

function suggest(before) {
  const { path, blocked } = scan(before);
  if (blocked) return { items: [], prefix: "" };

  const fields = fieldsOf(typeAt(before, path));
  const prefix = TRAILING_WORD.exec(before)?.[0] ?? "";
  const needle = prefix.toLowerCase();

  const matches = needle
    ? fields.filter((field) => field.name.toLowerCase().startsWith(needle))
    : fields;

  return { items: matches.slice(0, MAX_SUGGESTIONS), prefix };
}

// The path always starts with whatever opened the outermost selection set —
// the word `query`, an operation name, or nothing at all for a bare `{ … }` —
// so that first entry is dropped and the root comes from the keyword instead.
function typeAt(before, path) {
  let current = /^\s*mutation\b/.test(before) ? outline.roots.mutation : outline.roots.query;

  for (const step of path.slice(1)) {
    const field = fieldsOf(current).find((candidate) => candidate.name === step);
    if (!field) return null;

    current = field.type;
  }

  return current;
}

const fieldsOf = (typeName) => outline.types[typeName] ?? [];

// Walks the text keeping the field name in front of each open brace. Strings,
// comments and argument lists are stepped over whole, so neither a brace in a
// description nor an identifier in an argument is mistaken for structure. An
// unterminated one means the caret is inside it, where a field name is not
// what you are typing — `blocked` says so.
function scan(text) {
  const path = [];
  let pending = null;
  let i = 0;

  while (i < text.length) {
    const character = text[i];
    let skipped = null;

    if (character === '"') skipped = skipString(text, i);
    else if (character === "#") skipped = skipComment(text, i);
    else if (character === "(") skipped = skipGroup(text, i);

    if (skipped !== null) {
      if (skipped < 0) return { path, blocked: true };

      i = skipped;
      continue;
    }

    if (character === "{") {
      path.push(pending);
      pending = null;
      i += 1;
      continue;
    }

    if (character === "}") {
      path.pop();
      pending = null;
      i += 1;
      continue;
    }

    IDENTIFIER.lastIndex = i;
    const word = IDENTIFIER.exec(text);

    if (word) {
      pending = word[0];
      i = IDENTIFIER.lastIndex;
      continue;
    }

    i += 1;
  }

  return { path, blocked: false };
}

// Each of these returns the index just past what it skipped, or -1 when the
// thing never closes before the caret.
function skipString(text, at) {
  if (text.startsWith('"""', at)) {
    const end = text.indexOf('"""', at + 3);

    return end < 0 ? -1 : end + 3;
  }

  for (let i = at + 1; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === '"') return i + 1;
    else if (text[i] === "\n") return -1;
  }

  return -1;
}

function skipComment(text, at) {
  const end = text.indexOf("\n", at);

  return end < 0 ? -1 : end + 1;
}

function skipGroup(text, at) {
  let depth = 0;

  for (let i = at; i < text.length; i += 1) {
    if (text[i] === '"') {
      const end = skipString(text, i);
      if (end < 0) return -1;

      i = end - 1;
    } else if (text[i] === "(") {
      depth += 1;
    } else if (text[i] === ")") {
      depth -= 1;

      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

function place(editor, popup) {
  const styles = getComputedStyle(editor);
  const lineHeight = parseFloat(styles.lineHeight) || 18;
  const point = caretPoint(editor, styles);

  const caretTop = editor.offsetTop + point.top - editor.scrollTop;
  const below = caretTop + lineHeight;
  const rightEdge = editor.offsetLeft + editor.clientWidth - popup.offsetWidth;

  // The pane clips whatever overflows it, so a list that would hang past the
  // bottom of the form goes above the caret rather than being cut in half.
  const flip = below + popup.offsetHeight > editor.form.clientHeight;

  popup.style.top = `${flip ? Math.max(0, caretTop - popup.offsetHeight) : below}px`;
  popup.style.left = `${Math.max(0, Math.min(editor.offsetLeft + point.left, rightEdge))}px`;
}

// Where the caret sits in pixels. The DOM does not expose that for a
// <textarea>, so measure it: copy the textarea's own text metrics onto a
// hidden div, fill it with everything up to the caret, and read off where a
// zero-width marker lands.
const MIRRORED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textIndent",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "boxSizing",
  "tabSize",
];

function caretPoint(editor, styles) {
  const mirror = document.createElement("div");
  const marker = document.createElement("span");

  for (const property of MIRRORED) mirror.style[property] = styles[property];

  Object.assign(mirror.style, {
    position: "absolute",
    top: "0",
    left: "-9999px",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    width: `${editor.clientWidth}px`,
  });

  mirror.textContent = editor.value.slice(0, editor.selectionStart);
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);

  const point = { top: marker.offsetTop, left: marker.offsetLeft };
  mirror.remove();

  return point;
}
