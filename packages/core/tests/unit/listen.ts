import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Anything that starts a Node HTTP server, such as an Express app. */
interface Listenable {
  listen(port: number, hostname: string, callback: () => void): Server;
}

/** A started test server and the URL to reach it. */
export interface LoopbackServer {
  server: Server;
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  base: string;
}

/**
 * Starts `app` on a free port of 127.0.0.1.
 * @param app The app to start.
 */
export async function listenOnLoopback(
  app: Listenable,
): Promise<LoopbackServer> {
  // A wildcard listener can share its port with another 127.0.0.1 listener, which then gets our requests.
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}
