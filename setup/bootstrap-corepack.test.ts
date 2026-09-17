import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// setup.sh against a system-wide Node whose global bin dir (/usr/bin) is
// read-only for the installing user: plain `corepack enable` fails with
// EACCES, as on a distro-packaged Node. Every external command is a stub on a
// sealed PATH, so the host's real node/corepack/pnpm/sudo never run.
const TOOLS = ['bash', 'date', 'mkdir', 'dirname', 'uname', 'id', 'grep', 'sed', 'head', 'cut', 'cat', 'chmod'];

let root: string;
let home: string;
let bin: string;

function stub(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function runBootstrap(): { status: number | null; stdout: string; log: string } {
  const result = spawnSync('bash', ['setup.sh'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: bin,
      HOME: home,
      CALLS: path.join(root, 'calls'),
      NANOCLAW_NO_DIAGNOSTICS: '1',
    },
  });
  const logFile = path.join(root, 'logs', 'bootstrap.log');
  return {
    status: result.status,
    stdout: result.stdout,
    log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '',
  };
}

function calls(): string {
  const file = path.join(root, 'calls');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-corepack-'));
  home = path.join(root, 'home');
  bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'setup', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), 'setup.sh'), path.join(root, 'setup.sh'));
  fs.copyFileSync(
    path.join(process.cwd(), 'setup', 'lib', 'diagnostics.sh'),
    path.join(root, 'setup', 'lib', 'diagnostics.sh'),
  );
  fs.writeFileSync(path.join(root, 'package.json'), '{ "packageManager": "pnpm@10.0.0" }\n');

  for (const tool of TOOLS) {
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(found, path.join(bin, tool));
  }
  stub('node', 'case "$1" in --version) echo v22.0.0 ;; esac; exit 0');
  stub('sudo', 'echo "sudo $*" >> "$CALLS"; exit 1');
  stub('npm', 'echo "npm $*" >> "$CALLS"; [ "$1" = "config" ] && { echo "$HOME/no-such-prefix"; exit 0; }; exit 1');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('setup.sh corepack bootstrap with a read-only global bin dir', () => {
  it('installs the pnpm shim into ~/.local/bin without sudo or npm', () => {
    stub(
      'corepack',
      [
        'echo "corepack $*" >> "$CALLS"',
        'if [ "$1" = "enable" ] && [ "$2" = "--install-directory" ]; then',
        '  printf \'#!/bin/bash\\nexit 0\\n\' > "$3/pnpm"; chmod +x "$3/pnpm"; exit 0',
        'fi',
        'echo "Internal Error: EACCES: permission denied, symlink -> /usr/bin/pnpm" >&2; exit 1',
      ].join('\n'),
    );

    const result = runBootstrap();

    expect(result.stdout).toContain('STATUS: success');
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'pnpm'))).toBe(true);
    expect(calls()).toContain(`corepack enable --install-directory ${home}/.local/bin pnpm`);
    expect(calls()).not.toContain('sudo');
    expect(calls()).not.toContain('npm install');
  });

  it('only retries corepack under sudo non-interactively and prints the manual fix when everything fails', () => {
    stub('corepack', 'echo "corepack $*" >> "$CALLS"; exit 1');

    const result = runBootstrap();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('STATUS: deps_failed');
    expect(result.stdout).toContain('corepack enable --install-directory ~/.local/bin pnpm');
    const sudoCalls = calls()
      .split('\n')
      .filter((line) => line.startsWith('sudo ') && line.includes('corepack'));
    // The sudo retry is Linux-only; wherever it runs it must never prompt.
    if (process.platform === 'linux') expect(sudoCalls.length).toBeGreaterThan(0);
    for (const call of sudoCalls) expect(call).toMatch(/^sudo -n /);
  });
});
