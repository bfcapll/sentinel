import { createPublicClient, webSocket } from 'viem';
import type { Logger } from '../log.js';

const makeClient = (url: string) =>
  createPublicClient({ transport: webSocket(url, { reconnect: true, keepAlive: true, retryCount: 5 }) });

/** A push source of new chain heads. */
export interface HeadSource {
  start(onHead: (blockNumber: number) => void, onError: (e: Error) => void): void;
  stop(): void;
}

/** `newHeads` subscription over WebSocket via viem (reconnects with backoff). */
export class WsHeadSource implements HeadSource {
  private stopFn: (() => void) | null = null;
  private client: ReturnType<typeof makeClient> | null = null;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
  ) {}

  start(onHead: (n: number) => void, onError: (e: Error) => void): void {
    this.client = makeClient(this.url);
    this.stopFn = this.client.watchBlockNumber({
      emitMissed: false,
      onBlockNumber: (n) => onHead(Number(n)),
      onError: (e) => {
        this.log.warn({ err: e.message }, 'ws newHeads error');
        onError(e);
      },
    });
  }

  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
    const c = this.client;
    this.client = null;
    // Close the socket so the process can exit; errors on close are irrelevant.
    void c?.transport.getRpcClient().then((r) => r.close()).catch(() => undefined);
  }
}
