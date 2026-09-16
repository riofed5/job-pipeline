/* HTML → chữ. Thuần, không dependency. Đủ cho JD và email alert, không cần đúng chuẩn.
   keepLinks: <a href="X">Y</a> → "Y (X)". Email của board để chức danh làm anchor text
   và URL trong href — bỏ thẻ mà không giữ href là mất link. */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16)) || m;
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10)) || m;
    return m;
  });
}

export function htmlToText(html, { keepLinks = false } = {}) {
  let s = String(html ?? "");
  s = s.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  if (keepLinks) {
    s = s.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (m, a, b, c, inner) => {
      const href = decodeEntities(a ?? b ?? c ?? "").trim();
      const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!/^https?:\/\//i.test(href)) return ` ${text} `;
      return text ? ` ${text} (${href}) ` : ` ${href} `;
    });
  }
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6]|ul|ol|table|section|article|blockquote)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
