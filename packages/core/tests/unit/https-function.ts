import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeToken } from '@genkit-ai/firebase/context';
import express from 'express';
import type { HttpsOptions } from 'firebase-functions/v2/https';
import { GenkitError } from 'genkit';
import { genkit, InMemorySessionStore } from 'genkit/beta';
import { onAgentRequest } from '../../src/handler.js';
import type { AgentRequestOptions, TurnLock } from '../../src/types.js';

/** A served `onAgentRequest` function and the lease sizes its lock saw. */
export interface ServedFunction {
  /** Base URL of the local server. */
  base: string;
  /** `leaseMs` of every lock acquire, in order. */
  leases: number[];
  /** Sends a turn on session `s1` with a fake ID token for uid `u1`. */
  postTurn(): Promise<Response>;
  /** Stops the server. */
  close(): Promise<void>;
}

/**
 * Serves the Cloud Function that `onAgentRequest` returns, with the real
 * Firebase auth context provider and a lock whose acquire fails with
 * `ABORTED`, so a turn that passes auth answers 409 without running the agent.
 * @param httpsOptions Passed to `onAgentRequest`.
 * @param options Other `onAgentRequest` options.
 */
export async function serveAgentFunction(
  httpsOptions?: HttpsOptions,
  options: Pick<AgentRequestOptions, 'enforceAppCheck'> = {},
): Promise<ServedFunction> {
  const ai = genkit({});
  const agent = ai.defineAgent({
    name: 'testAgent',
    store: new InMemorySessionStore(),
  });
  const leases: number[] = [];
  const lock: TurnLock = {
    acquire: async (_key, { leaseMs }) => {
      leases.push(leaseMs);
      throw new GenkitError({ status: 'ABORTED', message: 'held' });
    },
    renew: async () => false,
    release: async () => {},
  };
  const fn = onAgentRequest(agent, {
    ...options,
    lock,
    httpsOptions,
  });
  const host = express();
  host.use((req, res) =>
    fn(Object.assign(req, { rawBody: Buffer.alloc(0) }), res),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = host.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    leases,
    postTurn: () =>
      fetch(base, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fakeToken({ sub: 'u1' })}`,
        },
        body: JSON.stringify({
          data: { message: { role: 'user', content: [{ text: 'hi' }] } },
          init: { sessionId: 's1' },
        }),
      }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
