import { spawn } from 'node:child_process';
import path from 'node:path';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/** Shell for tabs: $SHELL on unix, PowerShell on Windows. */
export const SHELL = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
export const SHELL_NAME = path.basename(SHELL).replace(/\.exe$/i, '');

/** Arguments that start `SHELL` interactively, optionally running `command` first. */
export function shellArgs(command?: string): string[] {
  if (isWin) return command ? ['-NoLogo', '-NoExit', '-Command', command] : ['-NoLogo'];
  return command ? ['-l', '-i', '-c', command] : ['-l'];
}

/** Put UTF-8 `text` on the system clipboard; `onError` runs if no clipboard tool could be started. */
export function copyText(text: string, onError: () => void): void {
  const utf8 = { ...process.env, LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' };
  // pbcopy reads MacRoman without a UTF-8 locale (apps launched from Finder have no LANG); `clip` uses the OEM code page.
  const [cmd, args]: [string, string[]] = isMac ? ['pbcopy', []]
    : isWin ? ['powershell.exe', ['-NoProfile', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']]
    : ['xclip', ['-selection', 'clipboard']];
  const p = spawn(cmd, args, { env: utf8, windowsHide: true });
  p.on('error', onError);
  p.stdin.on('error', onError);
  p.stdin.end(text);
}
