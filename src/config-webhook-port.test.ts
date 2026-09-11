import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use real .env files, as in #2977, and exercise the shared listener as well
// as #3148's configuration lookup. Each test owns its cwd and environment.
describe('WEBHOOK_PORT configuration (#2901)', () => {
  const originalCwd = process.cwd();
  let directory: string;
  let stopWebhookServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-webhook-port-'));
    process.chdir(directory);
    vi.stubEnv('WEBHOOK_PORT', undefined);
    vi.resetModules();
    stopWebhookServer = undefined;
  });

  afterEach(async () => {
    try {
      await stopWebhookServer?.();
    } finally {
      process.chdir(originalCwd);
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads the port from .env without populating process.env', async () => {
    fs.writeFileSync(path.join(directory, '.env'), 'WEBHOOK_PORT=3097\n');
    const { getWebhookPort } = await import('./config.js');

    expect(getWebhookPort()).toBe(3097);
    expect(process.env.WEBHOOK_PORT).toBeUndefined();
  });

  it('defaults to 3000 when neither source sets a port', async () => {
    const { getWebhookPort } = await import('./config.js');

    expect(getWebhookPort()).toBe(3000);
  });

  it('lets the process environment override .env', async () => {
    fs.writeFileSync(path.join(directory, '.env'), 'WEBHOOK_PORT=3097\n');
    vi.stubEnv('WEBHOOK_PORT', '4111');
    const { getWebhookPort } = await import('./config.js');

    expect(getWebhookPort()).toBe(4111);
  });

  it('honors a process override set after config was imported', async () => {
    fs.writeFileSync(path.join(directory, '.env'), 'WEBHOOK_PORT=3097\n');
    const { getWebhookPort } = await import('./config.js');
    expect(getWebhookPort()).toBe(3097);

    vi.stubEnv('WEBHOOK_PORT', '4111');
    expect(getWebhookPort()).toBe(4111);
  });

  it.each(['.env', 'late process override'])('serves HTTP on the port selected by %s', async (source) => {
    const port = 21000 + Math.floor(Math.random() * 20000);
    fs.writeFileSync(path.join(directory, '.env'), `WEBHOOK_PORT=${source === '.env' ? port : 3097}\n`);
    const { getWebhookPort } = await import('./config.js');
    if (source === 'late process override') vi.stubEnv('WEBHOOK_PORT', String(port));
    expect(getWebhookPort()).toBe(port);

    const webhook = await import('./webhook-server.js');
    stopWebhookServer = webhook.stopWebhookServer;
    webhook.registerWebhookHandler('port-check', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(String(req.socket.localPort));
    });

    await vi.waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/webhook/port-check`, {
          signal: AbortSignal.timeout(500),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(String(port));
      },
      { timeout: 2000, interval: 25 },
    );
  });
});
