/**
 * In-memory Bot API double. Used by unit tests and by the replay harness, where the JSON-lines
 * file it writes is the "fake Telegram sink" that replay assertions read back.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Clock } from '../time.js';
import { TelegramError } from './api.js';
import type { BotClient, BotName, ChatId, InlineButton, SendOptions, TgUpdate } from './api.js';

export type FakeRecord =
  | { seq: number; at: number | null; bot: string; type: 'send'; chatId: ChatId; messageId: number; text: string; opts: SendOptions }
  | { seq: number; at: number | null; bot: string; type: 'edit'; chatId: ChatId; messageId: number; text: string; keyboard: InlineButton[][] | null }
  | { seq: number; at: number | null; bot: string; type: 'answer'; callbackId: string; text: string | null };

/** Records shared by every client of a gateway so the file keeps global call order. */
export class FakeSink {
  readonly records: FakeRecord[] = [];
  seq = 0;
  #flushed = 0;

  constructor(readonly file?: string) {}

  /** Append records not yet written. No-op without a file. */
  flush(): void {
    if (!this.file) return;
    const fresh = this.records.slice(this.#flushed);
    if (fresh.length === 0) return;
    mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    appendFileSync(this.file, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
    this.#flushed = this.records.length;
  }
}

export interface FakeBotOptions {
  /** JSON-lines output file (creates a private sink). */
  file?: string;
  /** Share a sink with other clients (makeFakeGateway does this). */
  sink?: FakeSink;
  name?: string;
  clock?: Clock;
}

export class FakeBotClient implements BotClient {
  readonly name: string;
  readonly sink: FakeSink;
  private nextMessageId = 1;
  private failures: Array<unknown> = [];
  private updates: TgUpdate[] = [];
  private wake: Array<() => void> = [];
  /** Calls rejected by failNext(), per method. */
  failedCalls = 0;

  constructor(private opts: FakeBotOptions = {}) {
    this.name = opts.name ?? 'fake';
    this.sink = opts.sink ?? new FakeSink(opts.file);
  }

  /** Make the next `n` send/edit/answer calls reject (default: a Telegram 502). */
  failNext(n: number, error?: unknown): void {
    for (let i = 0; i < n; i++) {
      this.failures.push(error ?? new TelegramError({ method: 'fake', status: 502, description: 'Bad Gateway (simulated)' }));
    }
  }

  pushUpdate(update: TgUpdate): void {
    this.updates.push(update);
    for (const w of this.wake.splice(0)) w();
  }

  get sent(): Array<Extract<FakeRecord, { type: 'send' }>> {
    return this.mine().filter((r): r is Extract<FakeRecord, { type: 'send' }> => r.type === 'send');
  }
  get edits(): Array<Extract<FakeRecord, { type: 'edit' }>> {
    return this.mine().filter((r): r is Extract<FakeRecord, { type: 'edit' }> => r.type === 'edit');
  }
  get answers(): Array<Extract<FakeRecord, { type: 'answer' }>> {
    return this.mine().filter((r): r is Extract<FakeRecord, { type: 'answer' }> => r.type === 'answer');
  }

  flush(): void {
    this.sink.flush();
  }

  private mine(): FakeRecord[] {
    return this.sink.records.filter((r) => r.bot === this.name);
  }

  private base(): { seq: number; at: number | null; bot: string } {
    return { seq: ++this.sink.seq, at: this.opts.clock?.now() ?? null, bot: this.name };
  }

  private maybeFail(): void {
    if (this.failures.length > 0) {
      this.failedCalls++;
      throw this.failures.shift();
    }
  }

  sendMessage(chatId: ChatId, text: string, opts: SendOptions = {}): Promise<{ messageId: number }> {
    try {
      this.maybeFail();
    } catch (e) {
      return Promise.reject(e);
    }
    const messageId = this.nextMessageId++;
    this.sink.records.push({ ...this.base(), type: 'send', chatId, messageId, text, opts });
    return Promise.resolve({ messageId });
  }

  editMessageText(chatId: ChatId, messageId: number, text: string, opts: { keyboard?: InlineButton[][] | null } = {}): Promise<void> {
    try {
      this.maybeFail();
    } catch (e) {
      return Promise.reject(e);
    }
    this.sink.records.push({ ...this.base(), type: 'edit', chatId, messageId, text, keyboard: opts.keyboard ?? null });
    return Promise.resolve();
  }

  answerCallbackQuery(id: string, text?: string): Promise<void> {
    try {
      this.maybeFail();
    } catch (e) {
      return Promise.reject(e);
    }
    this.sink.records.push({ ...this.base(), type: 'answer', callbackId: id, text: text ?? null });
    return Promise.resolve();
  }

  /** Long-poll: resolves with queued updates, or [] after `timeoutS` or on abort. */
  async getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    const take = (): TgUpdate[] => {
      // Telegram drops updates below `offset` (they are confirmed).
      this.updates = this.updates.filter((u) => u.update_id >= offset);
      return this.updates.slice();
    };
    const ready = take();
    if (ready.length > 0 || timeoutS <= 0 || signal?.aborted) return ready;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutS * 1000);
      this.wake.push(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    if (signal?.aborted) {
      const err = new Error('getUpdates aborted');
      err.name = 'AbortError';
      throw err;
    }
    return take();
  }
}

export type FakeGateway = Record<BotName, FakeBotClient> & {
  /** Write all new records (all bots, in call order) to the sink file. */
  flush(): void;
  sink: FakeSink;
};

export function makeFakeGateway(file?: string, clock?: Clock): FakeGateway {
  const sink = new FakeSink(file);
  const make = (name: BotName): FakeBotClient => new FakeBotClient({ sink, name, ...(clock ? { clock } : {}) });
  return { p0: make('p0'), p1: make('p1'), p2: make('p2'), flush: () => sink.flush(), sink };
}
