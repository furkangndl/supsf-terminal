import fs from 'node:fs';
import path from 'node:path';
import { highlight, supportsLanguage } from 'cli-highlight';
import { RESET, bg, dim, fg, fit, truncate } from './ansi.js';

const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '.next', '.turbo', '__pycache__', '.venv']);
const MAX_FILE = 2 * 1024 * 1024;
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', php: 'php', java: 'java', kt: 'kotlin', swift: 'swift',
  json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', zsh: 'bash', css: 'css', scss: 'scss',
  html: 'xml', xml: 'xml', vue: 'xml', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', toml: 'ini',
};

interface Node {
  name: string;
  full: string;
  dir: boolean;
  depth: number;
}

export class CodePane {
  root: string;
  focus: 'tree' | 'view' = 'tree';
  private expanded = new Set<string>();
  private nodes: Node[] = [];
  private sel = 0;
  private treeTop = 0;
  file?: string;
  private lines: string[] = [];
  private viewTop = 0;
  private viewLeft = 0;

  constructor(root: string) {
    this.root = root;
    this.refresh();
  }

  setRoot(root: string): void {
    if (root === this.root) return;
    this.root = root;
    this.expanded.clear();
    this.file = undefined;
    this.lines = [];
    this.sel = this.treeTop = this.viewTop = 0;
    this.refresh();
  }

  refresh(): void {
    const out: Node[] = [];
    const walk = (dir: string, depth: number) => {
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      ents = ents.filter((e) => !IGNORE.has(e.name)).sort((a, b) =>
        a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1);
      for (const e of ents) {
        const full = path.join(dir, e.name);
        const node = { name: e.name, full, dir: e.isDirectory(), depth };
        out.push(node);
        if (node.dir && this.expanded.has(full)) walk(full, depth + 1);
      }
    };
    walk(this.root, 0);
    this.nodes = out;
    this.sel = Math.min(this.sel, Math.max(0, out.length - 1));
  }

  open(file: string): void {
    this.file = file;
    this.viewTop = this.viewLeft = 0;
    let text: string;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_FILE) {
        this.lines = [`${dim}(dosya çok büyük: ${(st.size / 1024 / 1024).toFixed(1)} MB)${RESET}`];
        return;
      }
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8000).includes(0)) {
        this.lines = [`${dim}(binary dosya)${RESET}`];
        return;
      }
      text = buf.toString('utf8').replace(/\t/g, '  ').replace(/\r/g, '');
    } catch (e: any) {
      this.lines = [`${dim}(okunamadı: ${e.message})${RESET}`];
      return;
    }
    const lang = EXT_LANG[path.extname(file).slice(1).toLowerCase()];
    if (lang && supportsLanguage(lang)) {
      try {
        text = highlight(text, { language: lang, ignoreIllegals: true });
      } catch {
        // fall back to plain text
      }
    }
    this.lines = text.split('\n');
  }

  /** Handle a key while focused. Returns true if consumed. */
  key(k: string, viewRows: number): boolean {
    if (k === '\t') {
      this.focus = this.focus === 'tree' ? 'view' : 'tree';
      return true;
    }
    if (this.focus === 'tree') return this.treeKey(k, viewRows);
    const page = Math.max(1, viewRows - 2);
    const maxTop = Math.max(0, this.lines.length - viewRows);
    switch (k) {
      case '\x1b[A': case 'k': this.viewTop--; break;
      case '\x1b[B': case 'j': this.viewTop++; break;
      case '\x1b[5~': case ' ': this.viewTop -= page; break;
      case '\x1b[6~': this.viewTop += page; break;
      case 'g': this.viewTop = 0; break;
      case 'G': this.viewTop = maxTop; break;
      case '\x1b[C': case 'l': this.viewLeft += 4; break;
      case '\x1b[D': case 'h':
        if (this.viewLeft === 0) this.focus = 'tree';
        this.viewLeft = Math.max(0, this.viewLeft - 4);
        break;
      default: return false;
    }
    this.viewTop = Math.max(0, Math.min(maxTop, this.viewTop));
    return true;
  }

  private treeKey(k: string, rows: number): boolean {
    const node = this.nodes[this.sel];
    switch (k) {
      case '\x1b[A': case 'k': this.sel = Math.max(0, this.sel - 1); break;
      case '\x1b[B': case 'j': this.sel = Math.min(this.nodes.length - 1, this.sel + 1); break;
      case '\x1b[5~': this.sel = Math.max(0, this.sel - rows); break;
      case '\x1b[6~': this.sel = Math.min(this.nodes.length - 1, this.sel + rows); break;
      case 'r': this.refresh(); break;
      case '\r': case '\x1b[C': case 'l':
        if (!node) break;
        if (node.dir) {
          if (this.expanded.has(node.full)) {
            if (k === '\r') this.expanded.delete(node.full);
          } else this.expanded.add(node.full);
          this.refresh();
        } else {
          this.open(node.full);
          if (k !== '\r') this.focus = 'view';
        }
        break;
      case '\x1b[D': case 'h':
        if (!node) break;
        if (node.dir && this.expanded.has(node.full)) {
          this.expanded.delete(node.full);
          this.refresh();
        } else {
          const parent = path.dirname(node.full);
          const idx = this.nodes.findIndex((n) => n.full === parent);
          if (idx >= 0) this.sel = idx;
        }
        break;
      default: return false;
    }
    return true;
  }

  treeWidth(total: number): number {
    return Math.min(30, Math.max(16, Math.floor(total * 0.3)));
  }

  /** Mouse click at pane-local coordinates. */
  click(x: number, y: number, cols: number): void {
    const tw = this.treeWidth(cols);
    if (x < tw) {
      this.focus = 'tree';
      const idx = this.treeTop + y - 1;
      if (idx >= 0 && idx < this.nodes.length) {
        const already = idx === this.sel;
        this.sel = idx;
        if (already || !this.nodes[idx].dir) this.treeKey('\r', 0);
      }
    } else {
      this.focus = 'view';
    }
  }

  wheel(x: number, delta: number, cols: number, rows: number): void {
    if (x < this.treeWidth(cols)) {
      this.treeTop = Math.max(0, Math.min(Math.max(0, this.nodes.length - rows + 1), this.treeTop + delta));
    } else {
      this.viewTop = Math.max(0, Math.min(Math.max(0, this.lines.length - rows + 1), this.viewTop + delta));
    }
  }

  render(cols: number, rows: number, focused: boolean): string[] {
    const tw = this.treeWidth(cols);
    const vw = cols - tw - 1;
    const bodyRows = rows - 1;
    if (this.sel < this.treeTop) this.treeTop = this.sel;
    if (this.sel >= this.treeTop + bodyRows) this.treeTop = this.sel - bodyRows + 1;

    const accent = focused ? fg(75) : fg(244);
    const head = (label: string, active: boolean, w: number) =>
      fit(`${bg(236)}${active && focused ? fg(75) + '\x1b[1m' : fg(250)} ${label}`, w);
    const relFile = this.file ? path.relative(this.root, this.file) : 'dosya seçilmedi';
    const out: string[] = [
      head('DOSYALAR', this.focus === 'tree', tw) + `${bg(236)}${accent}│${RESET}` +
        head(truncate(relFile, vw - 2), this.focus === 'view', vw),
    ];

    const gutter = String(this.lines.length).length;
    for (let i = 0; i < bodyRows; i++) {
      const n = this.nodes[this.treeTop + i];
      let left = '';
      if (n) {
        const isSel = this.treeTop + i === this.sel;
        const icon = n.dir ? (this.expanded.has(n.full) ? '▾ ' : '▸ ') : '  ';
        const color = n.dir ? fg(110) : n.full === this.file ? fg(222) : fg(252);
        const label = truncate('  '.repeat(n.depth) + icon + n.name, tw - 1);
        left = (isSel ? (focused && this.focus === 'tree' ? bg(24) : bg(238)) : '') + color + ' ' + label;
      }
      const li = this.viewTop + i;
      let right = '';
      if (li < this.lines.length && this.file) {
        const num = `${fg(240)}${String(li + 1).padStart(gutter)} ${RESET}`;
        right = num + fit(this.lines[li], Math.max(0, vw - gutter - 1), this.viewLeft);
      }
      out.push(fit(left, tw) + `${accent}│${RESET}` + fit(right, vw));
    }
    return out;
  }
}
