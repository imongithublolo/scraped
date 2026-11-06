/**
 * murke-ai — minimal markdown -> safe HTML (ported from the murke
 * extension's ui md.js). Everything is HTML-escaped FIRST, so the output
 * is safe by construction. Links become data-goto anchors: the chat pane
 * intercepts clicks and navigates the proxied tab instead of leaving the
 * app (there is no real tab to _blank into).
 */

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

function inline(s: string): string {
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="#" data-goto="$2">$1</a>',
    )
    .replace(
      /(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
      '$1<a href="#" data-goto="$2">$2</a>',
    );
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${esc(codes[+i])}</code>`);
}

export function md(src: string): string {
  const lines = String(src).replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push("<li>" + inline(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, "")) + "</li>");
      }
      out.push((ordered ? "<ol>" : "<ul>") + items.join("") + (ordered ? "</ol>" : "</ul>"));
    } else if (/^#{1,4}\s+/.test(l)) {
      out.push("<h4>" + inline(l.replace(/^#{1,4}\s+/, "")) + "</h4>");
      i++;
    } else if (/^>\s?/.test(l)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push("<blockquote>" + inline(buf.join(" ")) + "</blockquote>");
    } else if (!l.trim()) {
      i++;
    } else {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>|\s*([-*+]|\d+\.)\s)/.test(lines[i])) {
        buf.push(lines[i++]);
      }
      out.push("<p>" + buf.map(inline).join("<br>") + "</p>");
    }
  }
  return out.join("");
}
