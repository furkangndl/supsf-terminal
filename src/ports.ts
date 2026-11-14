import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isWin } from './platform.js';

export interface ListenPort {
  pid: number;
  port: number;
  /** Bind address as shown by lsof: `*`, `127.0.0.1`, `[::1]`, ... */
  addr: string;
  cmd: string;
  /** Full command line (`ps` args) and working directory, kept so a closed server can be started again. */
  args: string;
  cwd: string;
}

/** A server that was running and is not any more. */
export interface ClosedServer {
  port: number;
  addr: string;
  cmd: string;
  args: string;
  cwd: string;
  closedAt: number;
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 << 20, windowsHide: true, timeout: 5000 }, (_e, stdout) => resolve(stdout ?? ''));
  });

/** URL that opens this listener in a browser. */
export function portUrl(p: ListenPort): string {
  const host = p.addr === '*' || p.addr === '[::1]' || p.addr === '[::]' || p.addr === '0.0.0.0' ? 'localhost' : p.addr;
  return `http://${host}:${p.port}`;
}

/** Host part shown in the sidebar. */
export function portHost(p: { addr: string }): string {
  return p.addr === '*' || p.addr === '[::]' || p.addr === '0.0.0.0' ? 'localhost' : p.addr === '[::1]' ? 'localhost' : p.addr;
}

/** TCP listeners whose process working directory is inside `root` (unix only; Windows has no cwd lookup). */
export async function listPorts(root: string): Promise<ListenPort[]> {
  if (isWin) return [];
  const raw = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  const found = new Map<string, ListenPort>();
  let pid = 0;
  let cmd = '';
  for (const line of raw.split('\n')) {
    const v = line.slice(1);
    if (line[0] === 'p') pid = Number(v);
    else if (line[0] === 'c') cmd = v;
    else if (line[0] === 'n') {
      const m = /^(.*):(\d+)$/.exec(v);
      if (m) found.set(`${pid}:${m[2]}`, { pid, port: Number(m[2]), addr: m[1], cmd, args: '', cwd: '' });
    }
  }
  const pids = [...new Set([...found.values()].map((f) => f.pid))];
  if (!pids.length) return [];
  const cwds = new Map<number, string>();
  const cw = await run('lsof', ['-nP', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']);
  let cur = 0;
  for (const line of cw.split('\n')) {
    if (line[0] === 'p') cur = Number(line.slice(1));
    else if (line[0] === 'n') cwds.set(cur, line.slice(1));
  }
  const psOut = await run('ps', ['-o', 'pid=,args=', '-p', pids.join(',')]);
  const argsOf = new Map<number, string>();
  for (const line of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) argsOf.set(Number(m[1]), m[2]);
  }
  const base = path.resolve(root);
  const inside = (d: string) => d === base || d.startsWith(base + path.sep);
  // One row per port: prefer the IPv4 / specific bind over the IPv6 twin.
  const byPort = new Map<number, ListenPort>();
  for (const f of found.values()) {
    const d = cwds.get(f.pid);
    if (!d || !inside(d)) continue;
    f.cwd = d;
    f.args = argsOf.get(f.pid) ?? '';
    // Nuxt's internal worker (random port behind the real dev server) is not a URL to open.
    if (/nuxi(\.mjs)? _dev\b/.test(f.args)) continue;
    const old = byPort.get(f.port);
    if (!old || (old.addr.startsWith('[') && !f.addr.startsWith('['))) byPort.set(f.port, f);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export function killPort(p: ListenPort): void {
  try {
    process.kill(p.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

const CLOSED_FILE = path.join(os.homedir(), '.config', 'supsf-terminal', 'closed-servers.json');
const CLOSED_MAX = 20;

function readClosed(): Record<string, ClosedServer[]> {
  try {
    return JSON.parse(fs.readFileSync(CLOSED_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function loadClosed(root: string): ClosedServer[] {
  return readClosed()[root] ?? [];
}

export function saveClosed(root: string, list: ClosedServer[]): void {
  try {
    const all = readClosed();
    all[root] = list.slice(0, CLOSED_MAX);
    fs.mkdirSync(path.dirname(CLOSED_FILE), { recursive: true });
    fs.writeFileSync(CLOSED_FILE, JSON.stringify(all, null, 2) + '\n');
  } catch {
    // not worth crashing the UI over
  }
}

/** Shell command that starts a closed server again, in its old directory and on its old port. */
export function restartCommand(c: ClosedServer): string {
  const quoted = `'${c.cwd.replace(/'/g, `'\\''`)}'`;
  // Tools that read PORT (listhen / most Node servers) keep the port even when it was not on the command line.
  const env = c.args.includes(String(c.port)) ? '' : `PORT=${c.port} `;
  return `cd ${quoted} && ${env}${c.args}`;
}
