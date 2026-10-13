/**
 * Thin Telegram Bot API client over an injectable `fetch`. Nothing here may ever expose the
 * bot token: it lives in a #private field and every error message is redacted.
 */
import type { SentinelConfig } from '../config/schema.js';

export type BotName = 'p0' | 'p1' | 'p2';
export type ChatId = string | number;

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
  date?: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface SendOptions {
  replyToMessageId?: number;
  keyboard?: InlineButton[][];
  silent?: boolean;
  /** Send without parse_mode: the fallback when Telegram rejects the HTML. */
  plain?: boolean;
}

export interface BotClient {
  sendMessage(chatId: ChatId, text: string, opts?: SendOptions): Promise<{ messageId: number }>;
  /** `keyboard: null` (or omitted) removes the inline keyboard, as Telegram does. */
  editMessageText(chatId: ChatId, messageId: number, text: string, opts?: { keyboard?: InlineButton[][] | null }): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  /** `signal` lets the poller abort a long poll promptly on shutdown. */
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]>;
}

export type Gateway = Record<BotName, BotClient>;

export class TelegramError extends Error {
  readonly method: string;
  /** HTTP status; 0 for network errors and timeouts. */
  readonly status: number;
  /** Telegram's own `error_code`, when the body carried one. */
  readonly errorCode: number | null;
  readonly description: string;
  /** Seconds to wait, from a 429 response. */
  readonly retryAfter: number | null;

  constructor(init: { method: string; status: number; errorCode?: number | null; description: string; retryAfter?: number | null }) {
    super(`Telegram ${init.method} failed (${init.status}${init.errorCode ? `/${init.errorCode}` : ''}): ${init.description}`);
    this.name = 'TelegramError';
    this.method = init.method;
    this.status = init.status;
    this.errorCode = init.errorCode ?? null;
    this.description = init.description;
    this.retryAfter = init.retryAfter ?? null;
  }
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface HttpBotClientOptions {
  token: string;
  fetch?: typeof fetch;
  /** Per-request timeout; getUpdates adds its long-poll window on top. */
  timeoutMs?: number;
  baseUrl?: string;
}

export class HttpBotClient implements BotClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;

  constructor(opts: HttpBotClientOptions) {
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#baseUrl = opts.baseUrl ?? 'https://api.telegram.org';
  }

  #redact(s: string): string {
    let out = this.#token.length > 0 ? s.split(this.#token).join('<redacted>') : s;
    out = out.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
    return out;
  }

  async #call<T>(method: string, body: Record<string, unknown>, extraTimeoutMs = 0, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.#timeoutMs + extraTimeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (e) {
      if (signal?.aborted) {
        const err = new Error(`${method} aborted`);
        err.name = 'AbortError';
        throw err;
      }
      // Deliberately no `cause`: undici errors can embed the request URL, which contains the token.
      const reason = timeout.aborted ? 'timeout' : this.#redact(e instanceof Error ? e.message : String(e));
      throw new TelegramError({ method, status: 0, description: `network error: ${reason}` });
    }
    let payload: ApiResponse<T> | null = null;
    try {
      payload = (await res.json()) as ApiResponse<T>;
    } catch {
      payload = null;
    }
    if (!res.ok || !payload || !payload.ok) {
      throw new TelegramError({
        method,
        status: res.status,
        errorCode: payload?.error_code ?? null,
        description: this.#redact(payload?.description ?? res.statusText ?? 'unknown error'),
        retryAfter: payload?.parameters?.retry_after ?? null,
      });
    }
    return payload.result as T;
  }

  async sendMessage(chatId: ChatId, text: string, opts: SendOptions = {}): Promise<{ messageId: number }> {
    const body: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
    if (!opts.plain) body['parse_mode'] = 'HTML';
    if (opts.silent) body['disable_notification'] = true;
    if (opts.replyToMessageId !== undefined) {
      body['reply_to_message_id'] = opts.replyToMessageId;
      // A deleted original must not turn a RESOLVED notice into a permanent failure.
      body['allow_sending_without_reply'] = true;
    }
    if (opts.keyboard) body['reply_markup'] = toMarkup(opts.keyboard);
    const result = await this.#call<{ message_id?: number }>('sendMessage', body);
    if (typeof result?.message_id !== 'number') {
      throw new TelegramError({ method: 'sendMessage', status: 200, description: 'response carried no message_id' });
    }
    return { messageId: result.message_id };
  }

  async editMessageText(chatId: ChatId, messageId: number, text: string, opts: { keyboard?: InlineButton[][] | null } = {}): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: toMarkup(opts.keyboard ?? []),
    };
    try {
      await this.#call<unknown>('editMessageText', body);
    } catch (e) {
      // Re-sending identical text/markup is a no-op, not a failure (idempotent ACK edits).
      if (e instanceof TelegramError && e.status === 400 && /message is not modified/i.test(e.description)) return;
      throw e;
    }
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: id };
    if (text !== undefined) body['text'] = text;
    await this.#call<unknown>('answerCallbackQuery', body);
  }

  async getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    const result = await this.#call<TgUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutS, allowed_updates: ['message', 'callback_query'] },
      timeoutS * 1000,
      signal,
    );
    return Array.isArray(result) ? result : [];
  }

  toJSON(): Record<string, never> {
    return {};
  }
}

function toMarkup(keyboard: InlineButton[][]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callbackData }))) };
}

export function createHttpGateway(config: SentinelConfig['telegram'], fetchImpl?: typeof fetch): Gateway {
  const make = (token: string): BotClient => new HttpBotClient(fetchImpl ? { token, fetch: fetchImpl } : { token });
  return { p0: make(config.bots.p0.token), p1: make(config.bots.p1.token), p2: make(config.bots.p2.token) };
}
