export const ESC = '\x1b';
export const RESET = '\x1b[0m';

export const fg = (n: number) => `\x1b[38;5;${n}m`;
export const bg = (n: number) => `\x1b[48;5;${n}m`;
export const bold = '\x1b[1m';
export const dim = '\x1b[2m';
export const inverse = '\x1b[7m';

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
const WIDE_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u;

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp < 32 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  return WIDE_RE.test(ch) ? 2 : 1;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function width(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

/** Clip an ANSI-styled string to `w` visible columns, skipping the first `skip` columns, and pad with spaces. */
export function fit(s: string, w: number, skip = 0): string {
  let out = '';
  let col = 0;
  let i = 0;
  while (i < s.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    const cw = charWidth(ch);
    if (col < skip) {
      col += cw;
      continue;
    }
    if (col - skip + cw > w) break;
    out += ch;
    col += cw;
  }
  const used = Math.max(0, col - skip);
  return out + RESET + ' '.repeat(Math.max(0, w - used));
}

/**
 * One-column scrollbar. `total` lines, `top` first visible line, `rows` visible.
 * The thumb is painted with background color: block glyphs don't fill the cell height in xterm.js'
 * DOM renderer and leave gaps between rows. Returns undefined when everything fits.
 */
export function scrollbar(rows: number, total: number, top: number, color: number): string[] | undefined {
  if (total <= rows) return;
  const len = Math.max(1, Math.round((rows * rows) / total));
  const start = Math.round((top / (total - rows)) * (rows - len));
  const out: string[] = [];
  for (let r = 0; r < rows; r++) out.push(r >= start && r < start + len ? `${bg(color)} ${RESET}` : ' ');
  return out;
}

export function truncate(s: string, w: number): string {
  if (width(s) <= w) return s;
  let out = '';
  let col = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (col + cw > w - 1) break;
    out += ch;
    col += cw;
  }
  return out + '…';
}
