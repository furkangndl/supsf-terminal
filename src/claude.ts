import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ClaudeSession {
  id: string;
  title: string;
  /** File modification time; changes on resume too, so only used for staleness. */
  mtime: number;
  /** File creation time. */
  created: number;
  /** When the user last sent a prompt (falls back to mtime). */
  lastPrompt: number;
  /** When Claude last finished a turn after that prompt; undefined while a turn is in progress. */
  doneAt?: number;
  /** The last turn was interrupted by the user (no reply waiting). */
  interrupted: boolean;
}

type SessionInfo = Omit<ClaudeSession, 'id' | 'mtime' | 'created'>;

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CHUNK = 256 * 1024;
const BIG_CHUNK = 4 * 1024 * 1024;
const cache = new Map<string, { mtime: number; info: SessionInfo }>();

/** Claude Code stores sessions under ~/.claude/projects/<cwd with non-alphanumerics replaced by "-">. */
export function projectDir(cwd: string): string {
  return path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

function readSlice(file: string, start: number, len: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial line at chunk boundary
    }
  }
  return out;
}

function promptText(entry: any): string | undefined {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return;
  let c = entry.message?.content;
  if (Array.isArray(c)) c = c.find((p: any) => p?.type === 'text')?.text;
  if (typeof c !== 'string') return;
  const text = c.replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, '').trim();
  if (!text || text.startsWith('<') || text.startsWith('Caveat:')) return;
  return text.replace(/\s+/g, ' ');
}

const ts = (e: any) => (e.timestamp ? Date.parse(e.timestamp) : NaN);

/** Last user prompt and the turn end that followed it, scanning the newest entries first. */
function extractActivity(tail: any[]): Pick<SessionInfo, 'doneAt' | 'interrupted'> & { lastPrompt?: number } {
  let doneAt: number | undefined;
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    // Claude Code writes a turn_duration system entry when a turn completes.
    if (e.type === 'system' && e.subtype === 'turn_duration' && doneAt === undefined) doneAt = ts(e);
    const text = promptText(e);
    if (!text) continue;
    const at = ts(e);
    if (text.startsWith('[Request interrupted')) return { lastPrompt: at, doneAt: doneAt ?? at, interrupted: true };
    return { lastPrompt: at, doneAt, interrupted: false };
  }
  return { doneAt, interrupted: false };
}

function extractInfo(file: string, size: number, mtime: number): SessionInfo {
  let tail = parseLines(readSlice(file, Math.max(0, size - CHUNK), CHUNK));
  let act = extractActivity(tail);
  if (act.lastPrompt === undefined && size > CHUNK) {
    tail = parseLines(readSlice(file, Math.max(0, size - BIG_CHUNK), BIG_CHUNK));
    act = extractActivity(tail);
  }
  const lastPrompt = act.lastPrompt !== undefined && !Number.isNaN(act.lastPrompt) ? act.lastPrompt : mtime;
  return { title: extractTitle(file, tail), lastPrompt, doneAt: act.doneAt, interrupted: act.interrupted };
}

function extractTitle(file: string, tail: any[]): string {
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (e.type === 'custom-title' && e.customTitle) return e.customTitle;
  }
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (e.type === 'ai-title' && e.aiTitle) return e.aiTitle;
    if (e.type === 'summary' && e.summary) return e.summary;
  }
  for (const e of parseLines(readSlice(file, 0, CHUNK))) {
    const t = promptText(e);
    if (t) return t;
  }
  return '(başlıksız)';
}

export function listSessions(cwd: string): ClaudeSession[] {
  const dir = projectDir(cwd);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const sessions: ClaudeSession[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.size === 0) continue;
    let hit = cache.get(file);
    if (!hit || hit.mtime !== st.mtimeMs) {
      hit = { mtime: st.mtimeMs, info: extractInfo(file, st.size, st.mtimeMs) };
      cache.set(file, hit);
    }
    sessions.push({ id: name.slice(0, -6), mtime: st.mtimeMs, created: st.birthtimeMs, ...hit.info });
  }
  return sessions.sort((a, b) => b.lastPrompt - a.lastPrompt);
}

/** Deleted sessions are kept here, per project, so they can be restored. */
const TRASH_DIR = path.join(os.homedir(), '.config', 'supsf-terminal', 'trash');
/** Deleted sessions older than this are removed for good. */
const TRASH_DAYS = 30;

export interface TrashedSession {
  id: string;
  title: string;
  deletedAt: number;
}

const trashDir = (cwd: string) => path.join(TRASH_DIR, path.basename(projectDir(cwd)));

function move(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch {
    // different volume
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

/** Delete a session: its transcript and companion folder (tool results, subagents) move to the supsf trash. */
export function deleteSession(cwd: string, id: string): void {
  const from = projectDir(cwd);
  const to = trashDir(cwd);
  fs.mkdirSync(to, { recursive: true });
  for (const name of [`${id}.jsonl`, id]) {
    const src = path.join(from, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(to, name);
    fs.rmSync(dst, { recursive: true, force: true });
    move(src, dst);
    cache.delete(src);
  }
  fs.writeFileSync(path.join(to, `${id}.deleted`), String(Date.now()));
}

/** Put a deleted session back into the project. */
export function restoreSession(cwd: string, id: string): void {
  const from = trashDir(cwd);
  const to = projectDir(cwd);
  if (fs.existsSync(path.join(to, `${id}.jsonl`))) throw new Error('aynı session zaten var');
  fs.mkdirSync(to, { recursive: true });
  for (const name of [`${id}.jsonl`, id]) {
    const src = path.join(from, name);
    if (fs.existsSync(src)) move(src, path.join(to, name));
  }
  fs.rmSync(path.join(from, `${id}.deleted`), { force: true });
}

/** Deleted sessions of a project, newest deletion first; expired ones are purged. */
export function listTrashed(cwd: string): TrashedSession[] {
  const dir = trashDir(cwd);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: TrashedSession[] = [];
  for (const name of names) {
    const id = name.slice(0, -6);
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    let deletedAt = st.mtimeMs;
    try {
      deletedAt = +fs.readFileSync(path.join(dir, `${id}.deleted`), 'utf8') || deletedAt;
    } catch {
      // no marker
    }
    if (Date.now() - deletedAt > TRASH_DAYS * 86400_000) {
      for (const n of [name, id, `${id}.deleted`]) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      continue;
    }
    let hit = cache.get(file);
    if (!hit || hit.mtime !== st.mtimeMs) {
      hit = { mtime: st.mtimeMs, info: extractInfo(file, st.size, st.mtimeMs) };
      cache.set(file, hit);
    }
    out.push({ id, title: hit.info.title, deletedAt });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Rename a session the way Claude Code's /rename does: append a custom-title entry to its transcript. */
export function renameSession(cwd: string, id: string, title: string): void {
  const file = path.join(projectDir(cwd), `${id}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }) + '\n');
  cache.delete(file);
}

/** Whether a transcript contains entries copied from another session (Claude Code does this on resume). */
export function continues(cwd: string, id: string, fromId: string): boolean {
  try {
    return readSlice(path.join(projectDir(cwd), `${id}.jsonl`), 0, CHUNK).includes(`"sessionId":"${fromId}"`);
  } catch {
    return false;
  }
}

export function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'şimdi';
  if (s < 3600) return `${Math.floor(s / 60)}dk`;
  if (s < 86400) return `${Math.floor(s / 3600)}sa`;
  return `${Math.floor(s / 86400)}g`;
}
