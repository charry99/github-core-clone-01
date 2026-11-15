// main.ts — process entry point for the github-core-clone-01 forge.
//
// The process IS the server: it stays up for the whole trial.
//
//   1. Start the HTTP server on an ephemeral port (listen on port 0, never
//      8080 — the env owns that port on the same loopback).
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register, retrying a few
//      times on failure; a failed register never crashes the process.
//   3. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}, polling
//      on a short interval; never exit early.
//   4. Exit 0 once the env says done.
//   5. GET /healthz on the entry itself answers 200 {"ok": true} (see app.ts).
//
// With no MAKEFUN_ENV_URL set (a bare local run) the entry still starts its
// server and logs the port, and skips the register and poll steps.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createStore } from './store.ts';

const REGISTER_ATTEMPTS = 3;
const REGISTER_RETRY_DELAY_MS = 500;
const DONE_POLL_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** POST {"port": ...} to <envUrl>/register, with a few retries. */
async function register(envUrl: string, port: number): Promise<boolean> {
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      // 200 is a fresh register; 409 means the first register already won
      // (this process registered once already), which counts as registered.
      if ((response.status >= 200 && response.status < 300) || response.status === 409) return true;
      log(`register attempt ${attempt} answered HTTP ${response.status}`);
    } catch (err) {
      log(`register attempt ${attempt} failed (${errorMessage(err)})`);
    }
    if (attempt < REGISTER_ATTEMPTS) await sleep(REGISTER_RETRY_DELAY_MS);
  }
  return false;
}

/** GET <envUrl>/done until the body is {"done": true}; never throws. */
async function waitForDone(envUrl: string): Promise<void> {
  let firstErrorLogged = false;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const data: unknown = await response.json().catch(() => null);
        if (typeof data === 'object' && data !== null && (data as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch (err) {
      if (!firstErrorLogged) {
        process.stderr.write(`polling /done failed (${errorMessage(err)}); continuing to poll\n`);
        firstErrorLogged = true;
      }
    }
    await sleep(DONE_POLL_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  log('starting');
  const store = createStore();
  const server = createServer(createApp(store));
  server.on('error', (err: unknown) => {
    process.stderr.write(`server error: ${errorMessage(err)}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const port = address.port;
  log(`listening on port ${port}`);

  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    log('no MAKEFUN_ENV_URL set, running without register and poll');
    return;
  }

  const registered = await register(envUrl, port);
  log(registered ? 'registered' : 'register failed, polling anyway');
  log('polling');
  await waitForDone(envUrl);
  log('done');
  log('exiting');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${errorMessage(err)}\n`);
  process.exit(1);
});
