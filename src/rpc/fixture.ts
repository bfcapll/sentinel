import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RpcError, type RpcTransport } from './types.js';

export interface FixtureEntry {
  result?: unknown;
  error?: { code: number; message: string };
}

export interface Fixture {
  version: 1;
  meta: Record<string, unknown>;
  entries: Record<string, FixtureEntry>;
}

/** Canonical JSON: object keys sorted, so equal requests always produce equal keys. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Lower-case addresses/hex so checksummed and lower-case spellings hit the same entry. */
function normalise(v: unknown): unknown {
  if (typeof v === 'string') return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalise(x)]));
  return v;
}

export function requestKey(method: string, params: readonly unknown[]): string {
  return `${method}|${stableStringify(normalise(params))}`;
}

export function emptyFixture(meta: Record<string, unknown> = {}): Fixture {
  return { version: 1, meta, entries: {} };
}

export function loadFixture(file: string): Fixture {
  const f = JSON.parse(readFileSync(file, 'utf8')) as Fixture;
  if (f.version !== 1) throw new Error(`${file}: unsupported fixture version ${String(f.version)}`);
  return f;
}

export function saveFixture(file: string, fixture: Fixture): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sorted: Fixture = {
    ...fixture,
    entries: Object.fromEntries(Object.entries(fixture.entries).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
}

/** Wraps a real transport and records every response (including deterministic errors). */
export class RecordingTransport implements RpcTransport {
  readonly label: string;
  constructor(
    private readonly inner: RpcTransport,
    readonly fixture: Fixture,
  ) {
    this.label = `record(${inner.label})`;
  }

  async request(method: string, params: readonly unknown[] = []): Promise<unknown> {
    const key = requestKey(method, params);
    try {
      const result = await this.inner.request(method, params);
      this.fixture.entries[key] = { result };
      return result;
    } catch (e) {
      if (e instanceof RpcError && !e.transient) {
        this.fixture.entries[key] = { error: { code: e.opts.code ?? 0, message: e.message } };
      }
      throw e;
    }
  }
}

/** Serves recorded responses with no network. A miss is a hard, deterministic error. */
export class FixtureTransport implements RpcTransport {
  readonly label = 'fixture';
  misses: string[] = [];
  constructor(private readonly fixture: Fixture) {}

  request(method: string, params: readonly unknown[] = []): Promise<unknown> {
    const key = requestKey(method, params);
    const e = this.fixture.entries[key];
    if (!e) {
      this.misses.push(key);
      return Promise.reject(
        new RpcError(`fixture miss: ${key.slice(0, 300)} (re-record with --record, or the watcher's reads changed)`, {
          transient: false,
          method,
        }),
      );
    }
    if (e.error) return Promise.reject(new RpcError(e.error.message, { transient: false, code: e.error.code, method }));
    return Promise.resolve(e.result);
  }
}
