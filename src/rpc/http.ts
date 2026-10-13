import { RpcError, type RpcTransport } from './types.js';

export interface HttpTransportOptions {
  url: string;
  label: string;
  timeoutMs: number;
  /** Coalesce requests issued in the same tick into one JSON-RPC batch. */
  batch?: { maxSize: number; waitMs: number };
  fetchImpl?: typeof fetch;
}

interface Pending {
  method: string;
  params: readonly unknown[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Never put RPC keys (they live in the URL path) into logs or error text. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '<invalid-url>';
  }
}

/**
 * JSON-RPC errors that mean "this call is deterministically bad" (a revert, bad params).
 * Everything else (rate limits, "header not found" on a lagging node, internal errors) is
 * transient and worth retrying on another provider.
 */
function isDeterministic(code: number, message: string): boolean {
  if (code === 3) return true;
  if (/execution reverted|\brevert/i.test(message)) return true;
  return code === -32602 || code === -32601;
}

export class HttpTransport implements RpcTransport {
  readonly label: string;
  private queue: Pending[] = [];
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: HttpTransportOptions) {
    this.label = opts.label;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  request(method: string, params: readonly unknown[] = []): Promise<unknown> {
    if (!this.opts.batch) return this.send([{ method, params, resolve: () => {}, reject: () => {} }], true);
    return new Promise((resolve, reject) => {
      this.queue.push({ method, params, resolve, reject });
      if (this.queue.length >= this.opts.batch!.maxSize) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.opts.batch!.waitMs);
    });
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const items = this.queue.splice(0, this.opts.batch?.maxSize ?? this.queue.length);
    if (items.length === 0) return;
    void this.send(items, false);
    if (this.queue.length > 0) this.timer = setTimeout(() => this.flush(), this.opts.batch?.waitMs ?? 0);
  }

  /** Single (unbatched) mode returns the result; batch mode settles each pending promise. */
  private async send(items: Pending[], single: boolean): Promise<unknown> {
    const body =
      single || items.length === 1
        ? { jsonrpc: '2.0', id: this.nextId++, method: items[0]!.method, params: items[0]!.params }
        : items.map((it) => ({ jsonrpc: '2.0', id: this.nextId++, method: it.method, params: it.params }));
    const firstId = Array.isArray(body) ? (body[0] as { id: number }).id : body.id;

    const fail = (err: unknown): never | void => {
      if (single) throw err;
      for (const it of items) it.reject(err);
    };

    let text: string;
    try {
      const res = await this.doFetch(this.opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!res.ok) {
        const transient = res.status === 429 || res.status >= 500 || res.status === 408;
        return fail(new RpcError(`HTTP ${res.status} from ${this.label}`, { transient, code: res.status, provider: this.label }));
      }
      text = await res.text();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(new RpcError(`network error from ${this.label}: ${msg}`, { transient: true, provider: this.label }));
    }

    let parsed: JsonRpcResponse | JsonRpcResponse[];
    try {
      parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    } catch {
      return fail(new RpcError(`non-JSON response from ${this.label}`, { transient: true, provider: this.label }));
    }

    const toError = (r: JsonRpcResponse, method: string): RpcError =>
      new RpcError(`${method}: ${r.error!.message} (code ${r.error!.code})`, {
        transient: !isDeterministic(r.error!.code, r.error!.message),
        code: r.error!.code,
        provider: this.label,
        method,
      });

    if (!Array.isArray(parsed)) {
      if (parsed.error) return fail(toError(parsed, items[0]!.method));
      if (single) return parsed.result;
      items[0]!.resolve(parsed.result);
      return;
    }
    // Batch response: match by id (providers may reorder).
    const byId = new Map(parsed.map((r) => [r.id, r]));
    items.forEach((it, i) => {
      const r = byId.get(firstId + i);
      if (!r) it.reject(new RpcError(`missing batch response from ${this.label}`, { transient: true, provider: this.label }));
      else if (r.error) it.reject(toError(r, it.method));
      else it.resolve(r.result);
    });
    return undefined;
  }
}
