// Converts a Quill Delta's ops array into a small, safe HTML fragment,
// hand-rolled rather than pulled from a library because it only needs to
// cover the exact, finite set of formats this app's own toolbar and
// slash-menu can produce (see Editor.tsx's TOOLBAR_OPTIONS/SLASH_ITEMS).
// Used only by the timelapse export (timelapseExport.ts), which bakes a
// self-contained, dependency-free HTML file — bundling the real Quill
// renderer into that export isn't practical, so this is the deliberately
// simpler stand-in for it, scoped to exactly what the editor can produce.
//
// Delta content ultimately comes from whoever is editing the document, so
// every value that ends up in an href/style attribute is validated against
// an allowlist pattern below rather than trusted outright.

export interface DeltaOp {
  insert?: string | Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

interface Line {
  runs: { text: string; attrs: Record<string, unknown> }[];
  blockAttrs: Record<string, unknown>;
  divider?: boolean;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,\s%]+\))$/;

function safeColor(value: unknown): string | null {
  return typeof value === "string" && SAFE_COLOR.test(value.trim()) ? value.trim() : null;
}

function safeHref(value: unknown): string {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return escapeHtml(value);
  return "#";
}

function toLines(ops: DeltaOp[]): Line[] {
  const lines: Line[] = [];
  let currentRuns: Line["runs"] = [];

  for (const op of ops) {
    if (typeof op.insert !== "string") {
      if (op.insert && typeof op.insert === "object" && "divider" in op.insert) {
        if (currentRuns.length) {
          lines.push({ runs: currentRuns, blockAttrs: {} });
          currentRuns = [];
        }
        lines.push({ runs: [], blockAttrs: {}, divider: true });
      }
      continue;
    }
    const parts = op.insert.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) currentRuns.push({ text: parts[i], attrs: op.attributes ?? {} });
      if (i < parts.length - 1) {
        lines.push({ runs: currentRuns, blockAttrs: op.attributes ?? {} });
        currentRuns = [];
      }
    }
  }
  if (currentRuns.length) lines.push({ runs: currentRuns, blockAttrs: {} });
  return lines;
}

function renderRun(text: string, attrs: Record<string, unknown>): string {
  let html = escapeHtml(text);
  if (attrs.link) html = `<a href="${safeHref(attrs.link)}">${html}</a>`;
  if (attrs.bold) html = `<b>${html}</b>`;
  if (attrs.italic) html = `<em>${html}</em>`;
  if (attrs.underline) html = `<u>${html}</u>`;
  if (attrs.strike) html = `<s>${html}</s>`;
  const styles: string[] = [];
  const color = safeColor(attrs.color);
  const background = safeColor(attrs.background);
  if (color) styles.push(`color:${color}`);
  if (background) styles.push(`background:${background}`);
  if (styles.length) html = `<span style="${styles.join(";")}">${html}</span>`;
  return html;
}

function renderLineInner(line: Line): string {
  return line.runs.map((r) => renderRun(r.text, r.attrs)).join("") || "&nbsp;";
}

export function deltaToHtml(ops: DeltaOp[]): string {
  const lines = toLines(ops);
  const out: string[] = [];
  let listType: "bullet" | "ordered" | "check" | null = null;

  function closeList() {
    if (listType === "bullet") out.push("</ul>");
    else if (listType === "ordered") out.push("</ol>");
    else if (listType === "check") out.push("</ul>");
    listType = null;
  }

  for (const line of lines) {
    if (line.divider) {
      closeList();
      out.push("<hr>");
      continue;
    }
    const list = line.blockAttrs.list;
    const inner = renderLineInner(line);

    if (list === "bullet" || list === "ordered" || list === "check" || list === "unchecked" || list === "checked") {
      const kind = list === "bullet" ? "bullet" : list === "ordered" ? "ordered" : "check";
      if (listType !== kind) {
        closeList();
        out.push(kind === "ordered" ? "<ol>" : '<ul class="tl-list">');
        listType = kind;
      }
      const box = kind === "check" ? (list === "unchecked" ? "☐ " : "☑ ") : "";
      out.push(`<li>${box}${inner}</li>`);
      continue;
    }

    closeList();
    if (line.blockAttrs.header === 1) out.push(`<h1>${inner}</h1>`);
    else if (line.blockAttrs.header === 2) out.push(`<h2>${inner}</h2>`);
    else if (line.blockAttrs.header === 3) out.push(`<h3>${inner}</h3>`);
    else if (line.blockAttrs.blockquote) out.push(`<blockquote>${inner}</blockquote>`);
    else if (line.blockAttrs["code-block"]) out.push(`<pre><code>${inner}</code></pre>`);
    else out.push(`<p>${inner}</p>`);
  }
  closeList();
  return out.join("\n");
}
