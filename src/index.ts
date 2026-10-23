import { spawn } from 'node:child_process';
import path from 'node:path';
import { RESET, bg, dim, fg, fit, scrollbar, truncate, width } from './ansi.js';
import {
  ago, continues, deleteSession, listSessions, listTrashed, renameSession, restoreSession,
  type ClaudeSession, type TrashedSession,
} from './claude.js';
import { CodePane } from './codepane.js';
import { loadConfig, makeWorkspace, saveConfig, type Workspace } from './config.js';
import { TermPane } from './termpane.js';

type Focus = 'sidebar' | 'term' | 'code';

interface WsState {
  terms: TermPane[];
  active: number;
  code: CodePane;
  codeOpen: boolean;
}

type SideItem =
  | { kind: 'header'; label: string }
  | { kind: 'ws'; idx: number }
  | { kind: 'add-ws' }
  | { kind: 'new-claude' }
  | { kind: 'session'; s: ClaudeSession }
  | { kind: 'trash-toggle' }
  | { kind: 'trashed'; s: TrashedSession }
  | { kind: 'blank' };

interface Prompt {
  label: string;
  value: string;
  submit: (v: string) => void;
}

const out = process.stdout;
const cfg = loadConfig();
const PREFIX = cfg.prefix;
const PREFIX_NAME = PREFIX.length === 1 && PREFIX.charCodeAt(0) < 32
  ? `Ctrl+${String.fromCharCode(PREFIX.charCodeAt(0) + 64)}` : PREFIX;

const states = new Map<string, WsState>();
let activeWs = 0;
let focus: Focus = 'term';
let sidebarOpen = true;
let sideSel = 0;
let sideTop = 0;
let hoverSide = -1;
let hoverTab = -1;
/** True when the mouse is over the × close button of the hovered tab / sidebar session. */
let hoverClose = false;
/** Scrollbar state: mouse over it / dragging its thumb. */
let sbHover = false;
let sbDrag = false;
let pointer = false;
let sessions: ClaudeSession[] = [];
let trashed: TrashedSession[] = [];
/** Deleted sessions are listed in the sidebar. */
let trashOpen = false;
let prompt: Prompt | undefined;
let flash = '';
let flashTimer: NodeJS.Timeout | undefined;
let prefixPending = false;
let prevFrame: string[] = [];
let renderQueued = false;
let lastRender = 0;

// ---------- workspaces ----------

const startArg = process.argv[2];
for (const p of [startArg, cfg.workspaces.length ? undefined : process.cwd()]) {
  if (!p) continue;
  const ws = makeWorkspace(p);
  if (ws && !cfg.workspaces.some((w) => w.path === ws.path)) {
    cfg.workspaces.push(ws);
    saveConfig(cfg);
  }
}
{
  const want = path.resolve(startArg ?? process.cwd());
  const idx = cfg.workspaces.findIndex((w) => w.path === want);
  activeWs = idx >= 0 ? idx : 0;
}

const ws = (): Workspace | undefined => cfg.workspaces[activeWs];

function wsState(w: Workspace): WsState {
  let st = states.get(w.path);
  if (!st) {
    st = { terms: [], active: 0, code: new CodePane(w.path), codeOpen: false };
    states.set(w.path, st);
  }
  return st;
}

const cur = (): WsState | undefined => (ws() ? wsState(ws()!) : undefined);
const curTerm = (): TermPane | undefined => {
  const st = cur();
  return st?.terms[st.active];
};

function showFlash(msg: string): void {
  flash = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash = '';
    schedule();
  }, 3000);
  schedule();
}

function switchWs(idx: number): void {
  if (idx < 0 || idx >= cfg.workspaces.length) return;
  activeWs = idx;
  ensurePinned(cfg.workspaces[idx]);
  refreshSessions();
  layout();
  schedule();
}

/** Switch workspace and jump to its last session: last active tab, else resume newest Claude session. */
function openWs(idx: number): void {
  const w = cfg.workspaces[idx];
  if (!w) return;
  const st = wsState(w);
  // Only the permanent shell is open: jump into the newest Claude session.
  if (st.terms.every((t) => t.pinned)) {
    activeWs = idx;
    const latest = listSessions(w.path)[0];
    if (latest) openClaude(latest);
  }
  switchWs(idx);
  focus = 'term';
}

function addWorkspace(p: string): void {
  const w = makeWorkspace(p);
  if (!w) return showFlash(`Klasör bulunamadı: ${p}`);
  const existing = cfg.workspaces.findIndex((x) => x.path === w.path);
  if (existing >= 0) return switchWs(existing);
  cfg.workspaces.push(w);
  saveConfig(cfg);
  switchWs(cfg.workspaces.length - 1);
}

function removeWorkspace(idx: number): void {
  const w = cfg.workspaces[idx];
  if (!w) return;
  const st = states.get(w.path);
  states.delete(w.path);
  st?.terms.forEach((t) => t.kill());
  cfg.workspaces.splice(idx, 1);
  saveConfig(cfg);
  if (activeWs >= cfg.workspaces.length) activeWs = Math.max(0, cfg.workspaces.length - 1);
  if (cfg.workspaces.length) switchWs(activeWs);
  schedule();
}

// ---------- terminals ----------

const SHELL_NAME = path.basename(process.env.SHELL || 'zsh');
let quitting = false;

function spawnTerm(w: Workspace, opts: { command?: string; title?: string; sessionId?: string; pinned?: boolean }): TermPane {
  const st = wsState(w);
  const { tc, bh } = dims();
  return new TermPane({
    title: opts.title ?? SHELL_NAME, cwd: w.path, command: opts.command, sessionId: opts.sessionId,
    pinned: opts.pinned, cols: tc, rows: bh,
    onUpdate: schedule,
    onExit: (pane) => {
      const i = st.terms.indexOf(pane);
      const wasActive = i >= 0 && st.active === i;
      if (i >= 0) {
        st.terms.splice(i, 1);
        if (st.active > i || st.active >= st.terms.length) st.active = Math.max(0, st.active - 1);
      }
      // The permanent shell comes back (e.g. after `exit`) unless its workspace was removed or we are quitting.
      if (pane.pinned && !quitting && states.get(w.path) === st) {
        ensurePinned(w);
        if (wasActive) st.active = 0;
      }
      if (pane.sessionId !== undefined || opts.command) refreshSessions();
      schedule();
    },
  });
}

/** Every workspace keeps a shell as tab 0. */
function ensurePinned(w: Workspace | undefined): void {
  if (!w) return;
  const st = wsState(w);
  if (st.terms[0]?.pinned) return;
  const hadTabs = st.terms.length > 0;
  st.terms.unshift(spawnTerm(w, { pinned: true }));
  if (hadTabs) st.active++;
  schedule();
}

function newTerm(command?: string, title = SHELL_NAME, sessionId?: string): void {
  const w = ws();
  if (!w) return;
  const st = wsState(w);
  ensurePinned(w);
  st.terms.push(spawnTerm(w, { command, title, sessionId }));
  st.active = st.terms.length - 1;
  focus = 'term';
  schedule();
}

/** Close a tab; the permanent shell (tab 0) is only cleared. */
function closeTerm(t: TermPane | undefined): void {
  if (!t) return;
  if (t.pinned) t.clear();
  else t.kill();
  schedule();
}

function deleteSessionNow(s: ClaudeSession): void {
  const w = ws();
  if (!w) return;
  const remove = () => {
    try {
      deleteSession(w.path, s.id);
      showFlash('Session silindi · geri almak için u');
    } catch (e: any) {
      showFlash(`Silinemedi: ${e.message}`);
    }
    refreshSessions();
  };
  // Let a running Claude exit first so it does not write the transcript back after deletion.
  const t = sessionTerm(s.id);
  if (t && !t.exited) {
    t.proc.onExit(() => setTimeout(remove, 100));
    t.kill();
  } else remove();
}

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const HOUR = 3600_000;
/** A turn with no transcript writes for this long is treated as dead (crashed / killed elsewhere). */
const STALE = 10 * 60_000;
let spinFrame = 0;

/**
 * working: Claude is answering the last prompt.
 * replied: the answer finished less than an hour ago and the user has not written since.
 */
function sessionStatus(s: ClaudeSession): 'working' | 'replied' | 'idle' {
  const now = Date.now();
  if (s.doneAt === undefined) {
    const t = sessionTerm(s.id);
    const alive = t ? !t.exited : now - s.mtime < STALE;
    return alive ? 'working' : 'idle';
  }
  if (!s.interrupted && now - s.doneAt < HOUR) return 'replied';
  return 'idle';
}

/** Running tab for a Claude session in the current workspace, if any. */
const sessionTerm = (id: string) => cur()?.terms.find((t) => t.sessionId === id);

/** Claude tabs show their session's title (same as the sidebar), other tabs their own name. */
function tabTitle(t: TermPane): string {
  const s = t.sessionId ? sessions.find((x) => x.id === t.sessionId) : undefined;
  if (s) return `✻ ${s.title}`;
  return t.customTitle ?? t.title;
}

function restoreSessionNow(s: TrashedSession | undefined): void {
  const w = ws();
  if (!w || !s) return;
  try {
    restoreSession(w.path, s.id);
    showFlash(`Geri getirildi: ${truncate(s.title, 40)}`);
  } catch (e: any) {
    showFlash(`Geri getirilemedi: ${e.message}`);
  }
  refreshSessions();
}

function askRenameSession(s: ClaudeSession): void {
  prompt = {
    label: 'Session adı', value: s.title,
    submit: (v) => {
      const name = v.trim();
      const w = ws();
      if (!name || !w) return;
      try {
        renameSession(w.path, s.id, name);
      } catch (e: any) {
        showFlash(`Yeniden adlandırılamadı: ${e.message}`);
      }
      refreshSessions();
    },
  };
}

/** Rename a tab; a Claude tab renames its session so tab and sidebar stay the same. */
function askRenameTab(t: TermPane | undefined): void {
  if (!t) return;
  const s = t.sessionId ? sessions.find((x) => x.id === t.sessionId) : undefined;
  if (s) return askRenameSession(s);
  prompt = {
    label: 'Sekme adı', value: t.customTitle ?? t.title,
    // Empty name goes back to the program's own title.
    submit: (v) => { t.customTitle = v.trim() || undefined; schedule(); },
  };
}

function openClaude(s?: ClaudeSession): void {
  const st = cur();
  if (!st) return;
  if (s) {
    const open = st.terms.findIndex((t) => t.sessionId === s.id);
    if (open >= 0) {
      st.active = open;
      focus = 'term';
      return schedule();
    }
    newTerm(`claude --resume ${s.id}`, `✻ ${s.title}`, s.id);
  } else {
    newTerm('claude', '✻ claude', '');
  }
}

/**
 * Link Claude tabs to their transcript file. A new session gets a new file; a resumed one usually
 * continues in a new file that starts with a copy of the old conversation.
 */
function resolveTabSessions(w: Workspace, list: ClaudeSession[]): void {
  const terms = wsState(w).terms;
  const claimed = new Set(terms.map((t) => t.sessionId));
  for (const t of terms) {
    if (t.sessionId === undefined || t.sessionResolved) continue;
    if (Date.now() - t.startedAt > 60_000) {
      t.sessionResolved = true;
      continue;
    }
    const fresh = list
      .filter((s) => s.created >= t.startedAt - 2000 && !claimed.has(s.id))
      .sort((a, b) => a.created - b.created)
      .find((s) => !t.sessionId || continues(w.path, s.id, t.sessionId));
    if (!fresh) continue;
    claimed.delete(t.sessionId);
    t.sessionId = fresh.id;
    t.sessionResolved = true;
    claimed.add(fresh.id);
  }
}

function refreshSessions(): void {
  const w = ws();
  const next = w ? listSessions(w.path) : [];
  if (w) resolveTabSessions(w, next);
  const key = (l: ClaudeSession[]) => l.map((s) => [s.id, s.title, s.lastPrompt, s.doneAt, s.mtime].join('|')).join();
  const nextTrash = w ? listTrashed(w.path) : [];
  if (key(next) !== key(sessions) || nextTrash.map((s) => s.id).join() !== trashed.map((s) => s.id).join()) {
    sessions = next;
    trashed = nextTrash;
    schedule();
  }
}

// ---------- layout ----------

function dims() {
  const cols = out.columns || 80;
  const rows = out.rows || 24;
  const sw = sidebarOpen ? Math.min(cfg.sidebarWidth, Math.floor(cols / 3)) : 0;
  const mx = sidebarOpen ? sw + 1 : 0;
  const mw = cols - mx;
  const bh = Math.max(2, rows - 2);
  const codeOpen = cur()?.codeOpen ?? false;
  const tw = codeOpen ? Math.floor((mw - 1) / 2) : mw;
  const cw = codeOpen ? mw - tw - 1 : 0;
  // Terminal columns; the last column of the pane is the scrollbar.
  const tc = Math.max(2, tw - 1);
  return { cols, rows, sw, mx, mw, bh, tw, tc, cw, codeOpen };
}

let resizing = false;
let resizeTimer: NodeJS.Timeout | undefined;

function layout(): void {
  // While the window is being dragged, keep programs at their old size; they redraw once it settles.
  if (resizing) return;
  const { tc, bh } = dims();
  for (const t of cur()?.terms ?? []) t.resize(tc, bh);
}

// ---------- sidebar ----------

function sideItems(): SideItem[] {
  const items: SideItem[] = [{ kind: 'header', label: 'WORKSPACES' }];
  cfg.workspaces.forEach((_, idx) => items.push({ kind: 'ws', idx }));
  items.push({ kind: 'add-ws' }, { kind: 'blank' });
  items.push({ kind: 'header', label: `CLAUDE · ${ws()?.name ?? '-'}` }, { kind: 'new-claude' });
  for (const s of sessions) items.push({ kind: 'session', s });
  if (trashed.length) {
    items.push({ kind: 'blank' }, { kind: 'trash-toggle' });
    if (trashOpen) for (const s of trashed) items.push({ kind: 'trashed', s });
  }
  return items;
}

const selectable = (i: SideItem) => i.kind !== 'header' && i.kind !== 'blank';

function moveSide(delta: number): void {
  const items = sideItems();
  let i = sideSel;
  do i += delta; while (i >= 0 && i < items.length && !selectable(items[i]));
  if (i >= 0 && i < items.length) sideSel = i;
}

function activateSide(item: SideItem | undefined): void {
  if (!item) return;
  switch (item.kind) {
    case 'ws':
      openWs(item.idx);
      break;
    case 'add-ws':
      askAddWorkspace();
      break;
    case 'new-claude':
      openClaude();
      break;
    case 'session':
      openClaude(item.s);
      break;
    case 'trash-toggle':
      trashOpen = !trashOpen;
      break;
    case 'trashed':
      restoreSessionNow(item.s);
      break;
  }
  schedule();
}

function askAddWorkspace(): void {
  prompt = { label: 'Workspace klasörü', value: '~/Repos/', submit: addWorkspace };
}

function renderSidebar(sw: number, h: number): string[] {
  const items = sideItems();
  const activeSessionId = curTerm()?.sessionId;
  if (!selectable(items[sideSel] ?? { kind: 'blank' })) {
    sideSel = items.findIndex((i) => i.kind === 'ws');
    if (sideSel < 0) sideSel = 1;
  }
  if (sideSel < sideTop) sideTop = sideSel;
  if (sideSel >= sideTop + h) sideTop = sideSel - h + 1;
  const lines: string[] = [];
  for (let r = 0; r < h; r++) {
    const idx = sideTop + r;
    const it = items[idx];
    if (!it) {
      lines.push(' '.repeat(sw));
      continue;
    }
    const sel = idx === sideSel && focus === 'sidebar';
    const hovered = idx === hoverSide && selectable(it);
    // The session of the active tab stays highlighted, like the active workspace.
    const current = it.kind === 'session' && !!activeSessionId && it.s.id === activeSessionId;
    const selBg = sel ? bg(24) : hovered ? bg(236) : current ? bg(237) : '';
    let text = '';
    switch (it.kind) {
      case 'header':
        text = `${fg(244)}\x1b[1m ${truncate(it.label, sw - 2)}`;
        break;
      case 'blank':
        break;
      case 'ws': {
        const w = cfg.workspaces[it.idx];
        const n = states.get(w.path)?.terms.length ?? 0;
        const active = it.idx === activeWs;
        const badge = n ? ` ${fg(244)}${n}` : '';
        const name = truncate(w.name, sw - 5 - (n ? String(n).length + 1 : 0));
        text = `${selBg}${active ? fg(75) + '\x1b[1m ▸ ' : fg(252) + '   '}${name}\x1b[22m${badge}`;
        break;
      }
      case 'add-ws':
        text = `${selBg}${fg(244)}   + workspace ekle`;
        break;
      case 'new-claude':
        text = `${selBg}${fg(173)}   + yeni Claude session`;
        break;
      case 'session': {
        const t = hovered ? '×' : ago(it.s.lastPrompt);
        const status = sessionStatus(it.s);
        const mark = status === 'working' ? `${fg(173)}${SPINNER[spinFrame % SPINNER.length]}`
          : status === 'replied' ? `${fg(114)}●` : ' ';
        const title = truncate(it.s.title, sw - 6 - t.length);
        const pad = Math.max(1, sw - 4 - width(title) - t.length);
        const time = t === '×' ? (hoverClose ? `${bg(160)}${fg(255)}×${selBg}` : `${fg(250)}×`) : `${fg(242)}${t}`;
        text = `${selBg} ${mark} ${current ? fg(255) + '\x1b[1m' : fg(250)}${title}\x1b[22m${' '.repeat(pad)}${time}`;
        break;
      }
      case 'trash-toggle':
        text = `${selBg}${fg(244)} ${trashOpen ? '▾' : '▸'} silinenler (${trashed.length})`;
        break;
      case 'trashed': {
        const t = hovered ? '↺' : ago(it.s.deletedAt);
        const title = truncate(it.s.title, sw - 6 - t.length);
        const pad = Math.max(1, sw - 4 - width(title) - t.length);
        text = `${selBg}   ${fg(242)}${title}${' '.repeat(pad)}${hovered ? fg(114) : fg(240)}${t}`;
        break;
      }
    }
    lines.push(fit(selBg + text + selBg + ' '.repeat(sw), sw));
  }
  return lines;
}

// ---------- rendering ----------

function schedule(): void {
  if (renderQueued) return;
  renderQueued = true;
  const wait = Math.max(0, 16 - (Date.now() - lastRender));
  setTimeout(() => {
    renderQueued = false;
    lastRender = Date.now();
    render();
  }, wait);
}

/** Tab hit box: [start, end, tab index, x of the × button]. */
type TabRange = [number, number, number, number];

function tabBar(mw: number): { line: string; ranges: TabRange[] } {
  const st = cur();
  const ranges: TabRange[] = [];
  let line = `${bg(235)}`;
  let x = 0;
  st?.terms.forEach((t, i) => {
    const active = i === st.active;
    const label = ` ${i} ${truncate(tabTitle(t), 24)} `;
    const w = width(label) + 2;
    if (x + w > mw) return;
    const style = active ? `${bg(focus === 'term' ? 24 : 239)}${fg(255)}\x1b[1m`
      : i === hoverTab ? `${bg(238)}${fg(252)}` : `${bg(235)}${fg(246)}`;
    const closeHot = i === hoverTab && hoverClose;
    const close = closeHot ? `\x1b[22m${bg(160)}${fg(255)}×${style} ` : `\x1b[22m${fg(active || i === hoverTab ? 250 : 240)}×${style} `;
    line += style + label + close + `\x1b[22m${bg(235)}`;
    ranges.push([x, x + w, i, x + w - 2]);
    x += w;
  });
  return { line: fit(line, mw), ranges };
}

let lastTabRanges: TabRange[] = [];

function render(): void {
  const d = dims();
  layout();
  const frame: string[] = [];
  const side = sidebarOpen ? renderSidebar(d.sw, d.rows - 1) : [];
  const st = cur();
  const term = curTerm();
  const tb = tabBar(d.mw);
  lastTabRanges = tb.ranges;
  const termRows = term?.render();
  const sb = term && scrollbar(d.bh, term.scrollMax + d.bh, term.scrollMax - term.scroll,
    sbDrag || sbHover || term.scroll > 0 ? 250 : 240);
  const codeRows = st?.codeOpen ? st.code.render(d.cw, d.bh + 1, focus === 'code') : undefined;
  const border = (f: boolean) => `${f ? fg(75) : fg(238)}│${RESET}`;

  for (let y = 0; y < d.rows - 1; y++) {
    let line = sidebarOpen ? side[y] + border(focus === 'sidebar') : '';
    if (y === 0 && codeRows === undefined) {
      line += tb.line;
    } else if (y === 0 && codeRows) {
      line += fit(tb.line, d.tw) + border(focus === 'code') + codeRows[0];
    } else {
      let main: string;
      if (termRows) main = fit(termRows[y - 1] ?? '', d.tc) + (sb?.[y - 1] ?? ' ');
      else if (y === Math.floor(d.bh / 2)) {
        const msg = cfg.workspaces.length
          ? `Terminal yok — ${PREFIX_NAME} c: shell, ${PREFIX_NAME} a: Claude`
          : `Workspace yok — ${PREFIX_NAME} w ile ekle`;
        main = ' '.repeat(Math.max(0, Math.floor((d.tw - width(msg)) / 2))) + dim + msg;
      } else main = '';
      line += fit(main, d.tw);
      if (codeRows) line += border(focus === 'code') + codeRows[y];
    }
    frame.push(line);
  }
  frame.push(statusBar(d.cols));

  let buf = '\x1b[?2026h\x1b[?25l';
  for (let y = 0; y < frame.length; y++) {
    if (frame[y] !== prevFrame[y]) buf += `\x1b[${y + 1};1H${frame[y]}`;
  }
  prevFrame = frame;

  let cursor: { x: number; y: number } | undefined;
  if (prompt) {
    cursor = { x: width(promptPrefix()) + width(prompt.value), y: d.rows - 1 };
  } else if (focus === 'term' && term) {
    const c = term.cursor();
    if (c && c.x < d.tc && c.y < d.bh) cursor = { x: d.mx + c.x, y: 1 + c.y };
  }
  if (cursor) buf += `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`;
  out.write(buf + '\x1b[?2026l');
}

const promptPrefix = () => ` ${prompt!.label}: `;

function statusBar(cols: number): string {
  if (prompt) return fit(`${bg(24)}${fg(255)}${promptPrefix()}${prompt.value}${bg(24)}`, cols);
  const p = PREFIX_NAME;
  const hint = prefixPending
    ? ' c:shell  a:claude  x:kapat  r:adlandır  n/p:sekme  e:kod  s:sidebar  b:gizle  w:workspace  0-9:sekme  ←→:odak  q:çık'
    : focus === 'sidebar'
      ? ' ↑↓ seç  Enter aç  n adlandır  x session sil  u geri getir  d workspace sil  r yenile  Esc terminal'
      : focus === 'code'
        ? ' Tab ağaç/dosya  ↑↓ gez  Enter aç  ←→ kaydır  r yenile  Esc terminal'
        : ` ${p} komut modu  ·  ${p} ${p}: ${p} gönder`;
  const left = prefixPending ? `${bg(173)}${fg(16)}\x1b[1m ${p} \x1b[22m` : `${bg(24)}${fg(255)}\x1b[1m ${focus.toUpperCase()} \x1b[22m`;
  const right = flash ? `${fg(222)}${flash} ` : `${fg(244)}${ws()?.path ?? ''} `;
  const mid = `${bg(235)}${fg(246)}${hint}`;
  const space = cols - width(left) - width(mid) - width(right);
  return fit(left + mid + ' '.repeat(Math.max(1, space)) + right, cols);
}

// ---------- input ----------

const KEY_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO[\s\S]|\x1b[\s\S]?|[\s\S]/gu;
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

const CSI_U_RE = /\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::\d+)*)?u/g;

/**
 * The outer terminal runs with kitty keyboard flag 1 so Shift+Enter is distinguishable.
 * Turn every other CSI-u key back into the legacy bytes shells and our own keybindings expect.
 */
function legacyKeys(data: string): string {
  return data.replace(CSI_U_RE, (seq, codeStr: string, modStr?: string) => {
    const code = +codeStr;
    const mods = (modStr ? +modStr : 1) - 1;
    const shift = mods & 1, alt = mods & 2, ctrl = mods & 4;
    if (code === 13 && shift && !alt && !ctrl) return seq;
    let key: string;
    if (code === 27) key = '\x1b';
    else if (code === 13) key = '\r';
    else if (code === 9) key = shift ? '\x1b[Z' : '\t';
    else if (code === 127) key = ctrl ? '\b' : '\x7f';
    else if (code < 0x110000) {
      key = String.fromCodePoint(code);
      if (shift) key = key.toUpperCase();
      if (ctrl) {
        const c = key.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) key = String.fromCharCode(c - 96);
        else if (c === 32 || c === 50) key = '\x00';
        else if (c >= 91 && c <= 95) key = String.fromCharCode(c - 64);
      }
    } else return '';
    return alt ? '\x1b' + key : key;
  });
}

/** Sent by the Terminalo window for Cmd+C (kitty encoding of Super+c). */
const COPY_KEY = '\x1b[99;9u';

/** Sent by the Terminalo window for Cmd+A (Super+a). */
const SELECT_ALL_KEY = '\x1b[97;9u';

function handleInput(data: string): void {
  if (data.includes(SELECT_ALL_KEY)) {
    data = data.split(SELECT_ALL_KEY).join('');
    curTerm()?.selectAll();
  }
  if (data.includes(COPY_KEY)) {
    data = data.split(COPY_KEY).join('');
    const text = curTerm()?.selectedText();
    if (text) copyToClipboard(text);
  }
  data = legacyKeys(data);
  let last = 0;
  for (const m of data.matchAll(MOUSE_RE)) {
    if (m.index! > last) handleText(data.slice(last, m.index));
    handleMouse(+m[1], +m[2] - 1, +m[3] - 1, m[4] === 'M', m[0]);
    last = m.index! + m[0].length;
  }
  if (last < data.length) handleText(data.slice(last));
  schedule();
}

function handleText(text: string): void {
  if (prompt) {
    for (const k of text.match(KEY_RE) ?? []) promptKey(k);
    return;
  }
  while (text.length) {
    if (prefixPending) {
      const k = text.match(KEY_RE)![0];
      text = text.slice(k.length);
      prefixPending = false;
      prefixCommand(k);
      continue;
    }
    const i = text.indexOf(PREFIX);
    const before = i < 0 ? text : text.slice(0, i);
    if (before) {
      if (focus === 'term') curTerm()?.input(before);
      else for (const k of before.match(KEY_RE) ?? []) paneKey(k);
    }
    if (i < 0) break;
    prefixPending = true;
    text = text.slice(i + PREFIX.length);
  }
}

function promptKey(k: string): void {
  const p = prompt!;
  if (k === '\r') {
    prompt = undefined;
    p.submit(p.value);
  } else if (k === '\x1b' || k === '\x03') {
    prompt = undefined;
  } else if (k === '\x7f' || k === '\b') {
    p.value = [...p.value].slice(0, -1).join('');
  } else if (k === '\x15') {
    p.value = '';
  } else if (!k.startsWith('\x1b') && k >= ' ') {
    p.value += k;
  }
}

function confirm(label: string, yes: () => void): void {
  prompt = { label: `${label} (e/h)`, value: '', submit: (v) => /^(e|y)/i.test(v.trim()) && yes() };
}

function prefixCommand(k: string): void {
  const st = cur();
  switch (k) {
    case PREFIX: curTerm()?.input(PREFIX); break;
    case 'c': newTerm(); break;
    case 'a': openClaude(); break;
    case 'x': {
      const t = curTerm();
      if (t?.pinned) t.clear();
      else if (t) confirm(`"${truncate(tabTitle(t), 30)}" kapatılsın mı?`, () => t.kill());
      break;
    }
    case 'n': if (st?.terms.length) st.active = (st.active + 1) % st.terms.length; break;
    case 'p': if (st?.terms.length) st.active = (st.active - 1 + st.terms.length) % st.terms.length; break;
    case 'e':
      if (!st) break;
      st.codeOpen = !st.codeOpen || focus !== 'code';
      focus = st.codeOpen ? 'code' : 'term';
      if (st.codeOpen) st.code.refresh();
      layout();
      break;
    case 's': sidebarOpen = true; focus = 'sidebar'; layout(); break;
    case 'b': sidebarOpen = !sidebarOpen; if (!sidebarOpen && focus === 'sidebar') focus = 'term'; layout(); break;
    case 't': focus = 'term'; break;
    case 'w': askAddWorkspace(); break;
    case 'r': case ',': askRenameTab(curTerm()); break;
    case 'q': confirm('Çıkılsın mı? Tüm terminaller kapanır', quit); break;
    case '\x1b[D': moveFocus(-1); break;
    case '\x1b[C': moveFocus(1); break;
    case '\x1b[5~': curTerm()?.scrollBy(dims().bh - 1); animateScroll(); break;
    case '\x1b[6~': curTerm()?.scrollBy(-(dims().bh - 1)); animateScroll(); break;
    default:
      if (/^[0-9]$/.test(k) && st && +k < st.terms.length) st.active = +k;
  }
  if (focus === 'term' && k !== '\x1b[5~' && k !== '\x1b[6~') st?.terms[st.active]?.toBottom();
}

function moveFocus(dir: number): void {
  const order: Focus[] = [];
  if (sidebarOpen) order.push('sidebar');
  order.push('term');
  if (cur()?.codeOpen) order.push('code');
  const i = order.indexOf(focus);
  focus = order[Math.max(0, Math.min(order.length - 1, i + dir))];
}

function paneKey(k: string): void {
  if (k === '\x1b') {
    focus = 'term';
    return;
  }
  if (focus === 'code') {
    cur()?.code.key(k, dims().bh);
    return;
  }
  const items = sideItems();
  const item = items[sideSel];
  switch (k) {
    case '\x1b[A': case 'k': moveSide(-1); break;
    case '\x1b[B': case 'j': moveSide(1); break;
    case '\r': activateSide(item); break;
    case 'r': refreshSessions(); showFlash('Session listesi yenilendi'); break;
    case 'a': openClaude(); break;
    case 'x': if (item?.kind === 'session') deleteSessionNow(item.s); break;
    case 'n': if (item?.kind === 'session') askRenameSession(item.s); break;
    case 'u': restoreSessionNow(item?.kind === 'trashed' ? item.s : trashed[0]); break;
    case 'd':
      if (item?.kind === 'ws') {
        const w = cfg.workspaces[item.idx];
        confirm(`"${w.name}" listeden kaldırılsın mı? Terminalleri kapanır`, () => removeWorkspace(item.idx));
      }
      break;
  }
}

/** Track which sidebar item / tab is under the mouse; switch to a pointer cursor over clickable ones. */
function updateHover(x: number, y: number): void {
  const d = dims();
  let side = -1;
  let tab = -1;
  let close = false;
  if (y < d.rows - 1 && sidebarOpen && x < d.sw) {
    const it = sideItems()[sideTop + y];
    if (it && selectable(it)) side = sideTop + y;
    close = it?.kind === 'session' && x >= d.sw - 3;
  } else if (y === 0 && x >= d.mx) {
    const r = lastTabRanges.find(([a, z]) => x - d.mx >= a && x - d.mx < z);
    tab = r?.[2] ?? -1;
    close = !!r && x - d.mx >= r[3];
  }
  if (side !== hoverSide || tab !== hoverTab || close !== hoverClose) {
    hoverSide = side;
    hoverTab = tab;
    hoverClose = close;
    schedule();
  }
  const want = side >= 0 || tab >= 0;
  if (want !== pointer) {
    pointer = want;
    out.write(`\x1b]22;${want ? 'pointer' : 'default'}\x07`);
  }
}

function handleMouse(b: number, x: number, y: number, press: boolean, raw: string): void {
  const d = dims();
  // One line per wheel report; the SupSF window sends one report per line of movement.
  const wheel = b & 64 ? (b & 1 ? 1 : -1) : 0;
  const motion = (b & 32) !== 0;
  updateHover(x, y);
  if (y >= d.rows - 1) return;

  if (sidebarOpen && x < d.sw) {
    if (wheel) {
      sideTop = Math.max(0, sideTop + wheel);
      return;
    }
    if (!press || motion) return;
    focus = 'sidebar';
    const idx = sideTop + y;
    const it = sideItems()[idx];
    if (it && selectable(it)) {
      sideSel = idx;
      if (it.kind === 'session' && hoverClose) deleteSessionNow(it.s);
      else activateSide(it);
    }
    return;
  }
  const mx = x - d.mx;
  if (mx < 0) return;

  if (d.codeOpen && mx > d.tw) {
    const st = cur()!;
    const cx = mx - d.tw - 1;
    if (wheel) return st.code.wheel(cx, wheel, d.cw, d.bh);
    if (press && !motion) {
      focus = 'code';
      if (y > 0) st.code.click(cx, y, d.cw);
    }
    return;
  }

  if (y === 0) {
    if (!press || motion || wheel) return;
    const hit = lastTabRanges.find(([a, z]) => mx >= a && mx < z);
    if (hit && (mx >= hit[3] || (b & 3) === 1)) return closeTerm(cur()!.terms[hit[2]]);
    if (hit) cur()!.active = hit[2];
    focus = 'term';
    return;
  }

  const t = curTerm();
  if (!t) return;
  const onBar = mx === d.tw - 1 && y > 0 && t.scrollMax > 0;
  if (onBar !== sbHover) sbHover = onBar;
  if (sbDrag || (onBar && press && !motion && !wheel)) {
    sbDrag = press && (b & 3) !== 3;
    // Map the pointer row to a scroll position: top row = oldest line, bottom row = live output.
    const frac = Math.max(0, Math.min(1, (y - 1) / Math.max(1, d.bh - 1)));
    t.scrollTo((1 - frac) * t.scrollMax, true);
    return;
  }
  // Text selection: drag to select, release copies. Option+drag also works in programs that use the mouse.
  const alt = (b & 8) !== 0;
  const button = b & 3;
  if (!wheel && (selecting || ((!t.wantsMouse || alt) && press && !motion && button === 0))) {
    const pos = t.posAt(mx, y - 1);
    if (press && !motion) {
      focus = 'term';
      selecting = true;
      const now = Date.now();
      const same = lastClick && now - lastClick.at < 400 && lastClick.row === pos.row && Math.abs(lastClick.col - pos.col) <= 1;
      clickCount = same ? clickCount + 1 : 1;
      lastClick = { at: now, row: pos.row, col: pos.col };
      if (clickCount === 2) t.selectWord(pos);
      else if (clickCount >= 3) t.selectLine(pos);
      else t.selection = { anchor: pos, head: pos };
    } else if (press) {
      if (t.selection && clickCount === 1) t.selection.head = pos;
    } else {
      selecting = false;
      const text = t.selectedText();
      if (text) copyToClipboard(text);
      else t.selection = undefined;
    }
    return;
  }
  if (t.wantsMouse && t.scroll === 0) {
    // We track all motion for hover; forward motion only in the modes the inner app asked for.
    const mode = t.term.modes.mouseTrackingMode;
    if (motion && mode !== 'any' && (mode !== 'drag' || (b & 3) === 3)) return;
    if (press && !motion) focus = 'term';
    t.write(raw.replace(/<(\d+);\d+;\d+/, `<$1;${mx + 1};${y}`));
    return;
  }
  if (wheel) {
    t.scrollBy(-wheel);
    animateScroll();
  }
  else if (press && !motion) focus = 'term';
}

// ---------- lifecycle ----------

let selecting = false;
/** Multi-click detection for word (2) / line (3) selection. */
let clickCount = 0;
let lastClick: { at: number; row: number; col: number } | undefined;

function copyToClipboard(text: string): void {
  // Without a UTF-8 locale (apps launched from Finder have no LANG) pbcopy reads the text as MacRoman.
  const p = spawn('pbcopy', [], { env: { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' } });
  p.on('error', () => showFlash('Kopyalanamadı'));
  p.stdin.end(text);
  showFlash(`Kopyalandı (${[...text].length} karakter)`);
}

let scrollTimer: NodeJS.Timeout | undefined;

/** Run the active terminal's scroll animation at ~120 fps until it settles. */
function animateScroll(): void {
  if (scrollTimer) return;
  scrollTimer = setInterval(() => {
    const t = curTerm();
    if (!t || !t.animate()) {
      clearInterval(scrollTimer);
      scrollTimer = undefined;
    }
    render();
  }, 8);
}

function quit(): void {
  quitting = true;
  for (const st of states.values()) st.terms.forEach((t) => t.kill());
  out.write('\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b]22;default\x07\x1b[?2004l\x1b[0m\x1b[?25h\x1b[<u\x1b[?1049l');
  process.stdin.setRawMode?.(false);
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error('supsf-terminal bir TTY içinde çalışmalı.');
  process.exit(1);
}

out.write('\x1b[?1049h\x1b[2J\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[>1u');
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => handleInput(d));
out.on('resize', () => {
  // Repaint every row in place (no clear-screen, which shows a blank frame).
  resizing = true;
  prevFrame = [];
  render();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizing = false;
    layout();
    prevFrame = [];
    render();
  }, 150);
});
// The Terminalo window sends SIGWINCH after reloading its page; repaint even if the size is unchanged.
process.on('SIGWINCH', () => {
  prevFrame = [];
  schedule();
});
process.on('SIGTERM', quit);
process.on('SIGHUP', quit);
process.on('uncaughtException', (e) => {
  out.write('\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b]22;default\x07\x1b[?2004l\x1b[0m\x1b[?25h\x1b[<u\x1b[?1049l');
  console.error(e);
  process.exit(1);
});

if (cfg.workspaces.length) switchWs(activeWs);
setInterval(refreshSessions, 2000);
// Animate the working spinner; also lets the 1-hour "replied" dot expire on screen.
setInterval(() => {
  spinFrame++;
  if (sidebarOpen && sessions.some((s) => sessionStatus(s) !== 'idle')) schedule();
}, 120);
schedule();
