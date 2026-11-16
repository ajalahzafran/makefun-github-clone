// The entrypoint: bind the forge, tell the env where it lives, then stay up
// until the env says the trial is over. The graded run always sets
// MAKEFUN_ENV_URL; without it the process exits 1, exactly like the kit's
// starter. For local testing only, MAKEFUN_STANDALONE=1 runs the server on
// $PORT (or 3000) without registering anywhere.
//
//   1. Build the server and listen on an ephemeral port (the kernel picks
//      one). Port 8080 belongs to the env; this process never claims it.
//   2. POST {"port": <bound>} to $MAKEFUN_ENV_URL/register. A 200 registers
//      this process as the entry; a 409 means another entry registered first
//      and this process simply waits like any other. 400/405 are contract
//      errors and end the run; anything else is retried, because the env may
//      still be coming up.
//   3. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, polling
//      with a short exponential backoff. The process never exits before that.
//   4. Close the server and exit 0.
//
// The entrypoint's only job is this lifecycle; the server itself lives in
// app.ts. It makes no model calls and reads no package beyond node:http.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const STANDALONE = process.env.MAKEFUN_STANDALONE === '1';

/** One register/done request gets this long before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause. */
const RETRY_FIRST_MS = 250;
const RETRY_CEILING_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The pause after `attempt` failed attempts: exponential, capped. */
function retryPause(attempt: number): number {
  const exponent = Math.min(attempt, 8);
  return Math.min(RETRY_CEILING_MS, RETRY_FIRST_MS * 2 ** exponent);
}

function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

/**
 * Offer the bound port to the env. Resolves once the env has accepted it
 * (200) or another entry has already won the slot (409). A 400 or 405 means
 * the offer itself is malformed and is fatal; a refusal of any other kind is
 * retried forever.
 */
async function offerPort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await timedFetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected with HTTP ')) throw err;
    }
    await sleep(retryPause(attempt));
  }
}

/** Poll the env until it answers {"done": true}; never return sooner. */
async function waitForTrialEnd(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await timedFetch(`${ENV_URL}/done`);
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done.
    }
    await sleep(retryPause(attempt));
  }
}

/** Local testing: serve on a fixed port and never talk to an env. */
async function standalone(): Promise<void> {
  const port = Number(process.env.PORT ?? '3000') || 3000;
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  process.stdout.write(`[entry] standalone server on port ${port}\n`);
  await new Promise(() => {
    // Keep the process alive until it is killed.
  });
}

/** The graded lifecycle: bind ephemeral, register, wait, shut down. */
async function graded(): Promise<void> {
  if (ENV_URL === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await offerPort(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForTrialEnd();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await (STANDALONE ? standalone() : graded());
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
