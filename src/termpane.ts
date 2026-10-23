import pty from 'node-pty';
import xterm from '@xterm/headless';
import type { IBufferCell } from '@xterm/headless';

const { Terminal } = xterm;

export interface TermOptions {
  title: string;
  cwd: string;
  /** Shell command to run; undefined starts an interactive login shell. */
  command?: string;
  sessionId?: string;
  /** The workspace's permanent shell (tab 0): never closed, respawned on exit. */
  pinned?: boolean;
  cols: number;
  rows: number;
  onUpdate: () => void;
  onExit: (t: TermPane) => void;
}

function colorParams(mode: 'fg' | 'bg', cell: IBufferCell): string {
  const isFg = mode === 'fg';
  if (isFg ? cell.isFgDefault() : cell.isBgDefault()) return '';
  const c = isFg ? cell.getFgColor() : cell.getBgColor();
  if (isFg ? cell.isFgRGB() : cell.isBgRGB()) {
    return `;${isFg ? 38 : 48};2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`;
  }
  if (c < 8) return `;${(isFg ? 30 : 40) + c}`;
  if (c < 16) return `;${(isFg ? 90 : 100) + c - 8}`;
  return `;${isFg ? 38 : 48};5;${c}`;
}

const URL_RE = /https?:\/\/[^\s"'<>`│]*[^\s"'<>`│.,;:!?)\]}]/g;
/** Light blue for links (Ghostty palette bright blue #7aa6da). */
const LINK_FG = ';38;2;122;166;218';

/** Columns of a buffer line that are part of a URL. */
function linkCells(line: { translateToString(trim?: boolean): string; length: number; getCell(x: number, c?: IBufferCell): IBufferCell | undefined }, cell: IBufferCell): Set<number> {
  const cols = new Set<number>();
  // Map string offsets back to columns (wide chars take two cells, combining text can be several code units).
  let text = '';
  const colAt: number[] = [];
  for (let x = 0; x < line.length; x++) {
    if (!line.getCell(x, cell) || cell.getWidth() === 0) continue;
    const ch = cell.getChars() || ' ';
    for (let k = 0; k < ch.length; k++) colAt.push(x);
    text += ch;
  }
  if (!text.includes('://')) return cols;
  for (const m of text.matchAll(URL_RE)) {
    for (let k = m.index!; k < m.index! + m[0].length; k++) cols.add(colAt[k]);
  }
  return cols;
}

/** A buffer position: absolute line index (scrollback included) and column. */
export interface CellPos {
  row: number;
  col: number;
}

const SEL_BG = ';48;2;38;79;120';

/** The user's LANG if it is UTF-8, otherwise en_US.UTF-8. */
function utf8Lang(): string {
  const lang = process.env.LANG;
  return lang && /utf-?8/i.test(lang) ? lang : 'en_US.UTF-8';
}

export class TermPane {
  title: string;
  /** Name set by the user; overrides the program's title. */
  customTitle?: string;
  readonly cwd: string;
  /** Claude session shown in this tab; updated when Claude Code moves the conversation to a new file. */
  sessionId?: string;
  /** True once the transcript file for this tab has been identified. */
  sessionResolved = false;
  readonly startedAt = Date.now();
  /** Mouse text selection, anchor and moving end, in buffer coordinates. */
  selection?: { anchor: CellPos; head: CellPos };
  readonly pinned: boolean;
  readonly term: InstanceType<typeof Terminal>;
  readonly proc: pty.IPty;
  cursorHidden = false;
  /** Kitty keyboard protocol flags the inner program enabled (CSI > flags u). */
  kittyFlags = 0;
  /** Lines scrolled up from the bottom of the buffer (what is shown). */
  scroll = 0;
  /** Where `scroll` is animating towards. */
  private target = 0;
  exited = false;

  constructor(opts: TermOptions) {
    this.title = opts.title;
    this.cwd = opts.cwd;
    this.sessionId = opts.sessionId;
    this.pinned = opts.pinned ?? false;
    this.term = new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: 5000, allowProposedApi: true });

    const shell = process.env.SHELL || '/bin/zsh';
    const args = opts.command ? ['-l', '-i', '-c', opts.command] : ['-l'];
    this.proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      // Apps started from Finder/Dock get no LANG; without a UTF-8 locale zsh shows Turkish letters as <009f>.
      env: { ...process.env, LANG: utf8Lang(), TERM: 'xterm-256color', COLORTERM: 'truecolor', SUPSF_TERMINAL: '1' } as Record<string, string>,
    });

    for (const final of ['h', 'l'] as const) {
      this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (params.includes(25)) this.cursorHidden = final === 'l';
        return false;
      });
    }
    this.term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      this.kittyFlags = Number(params[0]) || 0;
      return true;
    });
    this.term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, () => {
      this.kittyFlags = 0;
      return true;
    });
    this.term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
      this.kittyFlags = Number(params[0]) || 0;
      return true;
    });
    this.term.onTitleChange((t) => {
      if (!opts.command && t) this.title = t;
      opts.onUpdate();
    });
    // xterm answers terminal queries (DA, cursor position...) through onData.
    this.term.onData((d) => this.write(d));
    this.proc.onData((d) => this.term.write(d, () => {
      if (this.scroll === 0) opts.onUpdate();
    }));
    this.proc.onExit(() => {
      this.exited = true;
      opts.onExit(this);
    });
  }

  write(data: string): void {
    if (!this.exited) this.proc.write(data);
  }

  /** Forward keyboard input, adapting to the modes the inner program enabled. */
  input(data: string): void {
    data = this.typeOverSelection(data);
    this.toBottom();
    const modes = this.term.modes;
    // Option+←/→ arrive as xterm modifier codes; shells (zsh/bash emacs keymap) move by word on Meta+b / Meta+f.
    if (this.sessionId === undefined) data = data.replace(/\x1b\[1;3D/g, '\x1bb').replace(/\x1b\[1;3C/g, '\x1bf');
    if (modes.applicationCursorKeysMode) data = data.replace(/\x1b\[([ABCDHF])/g, '\x1bO$1');
    if (!modes.bracketedPasteMode) data = data.replace(/\x1b\[20[01]~/g, '');
    // Shift+Enter arrives as CSI 13;2 u; programs without kitty mode (e.g. Claude Code) take Meta+Enter as newline.
    if (!this.kittyFlags) data = data.replace(/\x1b\[13;2u/g, '\x1b\r');
    this.write(data);
  }

  /**
   * Typing while text on the cursor's line is selected replaces it, like a text field:
   * move the cursor to the end of the selection and backspace over it before the key.
   */
  private typeOverSelection(data: string): string {
    const r = this.selRange();
    this.selection = undefined;
    const printable = data.length > 0 && !data.startsWith('\x1b') && (data >= ' ' || data === '\x7f' || data === '\b');
    if (!r || !printable || this.scroll > 0 || r[0].row !== r[1].row) return data;
    const buf = this.term.buffer.active;
    if (r[0].row !== buf.baseY + buf.cursorY) return data;
    const line = buf.getLine(r[0].row);
    if (!line) return data;
    const cell = buf.getNullCell();
    // Count characters (not cells) between columns, so wide characters move the cursor once.
    const chars = (from: number, to: number) => {
      let n = 0;
      for (let x = from; x < to; x++) if (line.getCell(x, cell) && cell.getWidth() > 0) n++;
      return n;
    };
    const end = r[1].col + 1;
    const x = buf.cursorX;
    const move = x <= end ? '\x1b[C'.repeat(chars(x, end)) : '\x1b[D'.repeat(chars(end, x));
    const erase = '\x7f'.repeat(chars(r[0].col, end));
    const typed = data === '\x7f' || data === '\b' ? '' : data;
    return move + erase + typed;
  }

  get wantsMouse(): boolean {
    return this.term.modes.mouseTrackingMode !== 'none';
  }

  resize(cols: number, rows: number): void {
    if (cols < 2 || rows < 2 || (cols === this.term.cols && rows === this.term.rows)) return;
    this.term.resize(cols, rows);
    if (!this.exited) this.proc.resize(cols, rows);
  }

  get scrollMax(): number {
    return this.term.buffer.active.baseY;
  }

  scrollBy(delta: number): void {
    this.scrollTo(this.target + delta);
  }

  scrollTo(pos: number, instant = false): void {
    this.target = Math.max(0, Math.min(this.scrollMax, Math.round(pos)));
    if (instant) this.scroll = this.target;
  }

  toBottom(): void {
    this.scroll = this.target = 0;
  }

  /** Advance the scroll animation one frame (ease-out). Returns true while still moving. */
  animate(): boolean {
    const diff = this.target - this.scroll;
    if (diff === 0) return false;
    const step = Math.sign(diff) * Math.max(1, Math.ceil(Math.abs(diff) * 0.35));
    this.scroll = Math.abs(step) >= Math.abs(diff) ? this.target : this.scroll + step;
    return true;
  }

  /** Wipe screen and scrollback, then let the program redraw (Ctrl+L). */
  clear(): void {
    this.toBottom();
    this.term.reset();
    this.write('\x0c');
  }

  kill(): void {
    if (!this.exited) this.proc.kill();
  }

  /** Render visible rows as SGR-styled strings, exactly `cols` cells wide. */
  /** Buffer position of a cell on screen, taking the scroll offset into account. */
  posAt(x: number, y: number): CellPos {
    const buf = this.term.buffer.active;
    return { row: buf.baseY - this.scroll + y, col: Math.max(0, Math.min(this.term.cols - 1, x)) };
  }

  /** Selection ordered from start to end (end column inclusive), or undefined if empty. */
  private selRange(): [CellPos, CellPos] | undefined {
    const s = this.selection;
    if (!s) return;
    const { anchor: a, head: b } = s;
    if (a.row === b.row && a.col === b.col) return;
    return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
  }

  /** Double-click: select the word (letters, digits, _) under a position, like a browser. */
  selectWord(pos: CellPos): void {
    const line = this.term.buffer.active.getLine(pos.row);
    if (!line) return;
    const cell = this.term.buffer.active.getNullCell();
    const isWord = (x: number) => !!line.getCell(x, cell) && /^[\p{L}\p{N}_]+$/u.test(cell.getChars());
    // Step onto the lead cell of a wide character.
    let col = pos.col;
    while (col > 0 && line.getCell(col, cell) && cell.getWidth() === 0) col--;
    if (!isWord(col)) {
      this.selection = { anchor: { row: pos.row, col }, head: { row: pos.row, col } };
      return;
    }
    let a = col;
    let b = col;
    while (a > 0 && (isWord(a - 1) || (line.getCell(a - 1, cell) && cell.getWidth() === 0 && isWord(a - 2)))) a--;
    while (b < this.term.cols - 1 && (isWord(b + 1) || (line.getCell(b + 1, cell) && cell.getWidth() === 0))) b++;
    this.selection = { anchor: { row: pos.row, col: a }, head: { row: pos.row, col: b } };
  }

  /** Triple-click: select the whole line. */
  selectLine(pos: CellPos): void {
    this.selection = { anchor: { row: pos.row, col: 0 }, head: { row: pos.row, col: this.term.cols - 1 } };
  }

  /** Select the whole buffer (scrollback + screen), up to the last non-empty line. */
  selectAll(): void {
    const buf = this.term.buffer.active;
    let last = buf.length - 1;
    while (last > 0 && !buf.getLine(last)?.translateToString(true)) last--;
    this.selection = { anchor: { row: 0, col: 0 }, head: { row: last, col: this.term.cols - 1 } };
  }

  selectedText(): string {
    const r = this.selRange();
    if (!r) return '';
    const buf = this.term.buffer.active;
    let text = '';
    for (let row = r[0].row; row <= r[1].row; row++) {
      const line = buf.getLine(row);
      if (!line) continue;
      const from = row === r[0].row ? r[0].col : 0;
      const to = row === r[1].row ? r[1].col + 1 : this.term.cols;
      text += line.translateToString(row !== r[1].row || to >= this.term.cols, from, to);
      // Soft-wrapped lines continue without a newline.
      if (row < r[1].row && !buf.getLine(row + 1)?.isWrapped) text = text.trimEnd() + '\n';
    }
    return text;
  }

  render(): string[] {
    const sel = this.selRange();
    const inSel = (row: number, col: number) => !!sel &&
      (row > sel[0].row || (row === sel[0].row && col >= sel[0].col)) &&
      (row < sel[1].row || (row === sel[1].row && col <= sel[1].col));
    const buf = this.term.buffer.active;
    const top = buf.baseY - this.scroll;
    const cell = buf.getNullCell();
    const rows: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(top + y);
      let out = '\x1b[0m';
      let prev = '';
      const links = line ? linkCells(line, cell) : undefined;
      for (let x = 0; x < this.term.cols; x++) {
        if (!line || !line.getCell(x, cell)) {
          if (prev !== '') out += '\x1b[0m';
          prev = '';
          out += ' ';
          continue;
        }
        const w = cell.getWidth();
        if (w === 0) continue;
        let sgr = '0' + (links?.has(x) ? LINK_FG : colorParams('fg', cell)) + (inSel(top + y, x) ? SEL_BG : colorParams('bg', cell));
        if (cell.isBold()) sgr += ';1';
        if (cell.isDim()) sgr += ';2';
        if (cell.isItalic()) sgr += ';3';
        if (cell.isUnderline()) sgr += ';4';
        if (cell.isInverse()) sgr += ';7';
        if (cell.isInvisible()) sgr += ';8';
        if (cell.isStrikethrough()) sgr += ';9';
        if (sgr !== prev) {
          out += `\x1b[${sgr}m`;
          prev = sgr;
        }
        out += cell.getChars() || ' ';
      }
      rows.push(out + '\x1b[0m');
    }
    return rows;
  }

  /** Cursor position inside the pane, or undefined when it should be hidden. */
  cursor(): { x: number; y: number } | undefined {
    if (this.cursorHidden || this.scroll > 0 || this.exited) return;
    const buf = this.term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY };
  }
}
