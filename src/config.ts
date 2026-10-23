import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Workspace {
  name: string;
  path: string;
}

export interface Config {
  workspaces: Workspace[];
  /** Prefix key as a control character, default Ctrl+B. */
  prefix: string;
  sidebarWidth: number;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'supsf-terminal');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(): Config {
  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // first run
  }
  return {
    workspaces: (raw.workspaces ?? []).filter((w) => w && w.path),
    prefix: raw.prefix ?? '\x02',
    sidebarWidth: raw.sidebarWidth ?? 32,
  };
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

export function makeWorkspace(p: string): Workspace | undefined {
  const abs = path.resolve(expandHome(p.trim()));
  try {
    if (!fs.statSync(abs).isDirectory()) return;
  } catch {
    return;
  }
  return { name: path.basename(abs), path: abs };
}
