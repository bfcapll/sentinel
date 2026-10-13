import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpBotClient, TelegramError, createHttpGateway } from '../src/telegram/api.js';
import { FakeBotClient, makeFakeGateway } from '../src/telegram/fake.js';
import { tgConfig } from './telegram-helpers.js';

const TOKEN = '123456:SECRET-token_value';

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(responses: Array<{ status?: number; body: unknown } | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(new Response(JSON.stringify(r?.body), { status: r?.status ?? 200 }));
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe('HttpBotClient', () => {
  it('sends HTML messages with keyboard, reply and no link preview', async () => {
    const { fetch, calls } = fakeFetch([{ body: { ok: true, result: { message_id: 77 } } }]);
    const c = new HttpBotClient({ token: TOKEN, fetch });
    const r = await c.sendMessage(-100, '<b>hi</b>', {
      replyToMessageId: 5,
      keyboard: [[{ text: 'ACK', callbackData: 'ack:1' }]],
      silent: true,
    });
    expect(r).toEqual({ messageId: 77 });
    const call = calls[0];
    expect(call?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(call?.body).toMatchObject({
      chat_id: -100,
      text: '<b>hi</b>',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: true,
      reply_to_message_id: 5,
      reply_markup: { inline_keyboard: [[{ text: 'ACK', callback_data: 'ack:1' }]] },
    });
  });

  it('plain mode drops parse_mode', async () => {
    const { fetch, calls } = fakeFetch([{ body: { ok: true, result: { message_id: 1 } } }]);
    await new HttpBotClient({ token: TOKEN, fetch }).sendMessage(1, 'x', { plain: true });
    expect(calls[0]?.body).not.toHaveProperty('parse_mode');
  });

  it('exposes status, errorCode and retryAfter on 429', async () => {
    const { fetch } = fakeFetch([
      { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } },
    ]);
    const err = await new HttpBotClient({ token: TOKEN, fetch }).sendMessage(1, 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    const te = err as TelegramError;
    expect(te.status).toBe(429);
    expect(te.errorCode).toBe(429);
    expect(te.retryAfter).toBe(7);
  });

  it('handles non-JSON 5xx bodies', async () => {
    const f = (() => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))) as typeof fetch;
    const err = (await new HttpBotClient({ token: TOKEN, fetch: f }).sendMessage(1, 'x').catch((e: unknown) => e)) as TelegramError;
    expect(err.status).toBe(502);
  });

  it('treats "message is not modified" on edit as success', async () => {
    const { fetch } = fakeFetch([
      { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content...' } },
    ]);
    await expect(new HttpBotClient({ token: TOKEN, fetch }).editMessageText(1, 2, 'x')).resolves.toBeUndefined();
  });

  it('still throws other edit errors, and removes the keyboard by default', async () => {
    const { fetch, calls } = fakeFetch([
      { body: { ok: true, result: true } },
      { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' } },
    ]);
    const c = new HttpBotClient({ token: TOKEN, fetch });
    await c.editMessageText(1, 2, 'x', { keyboard: null });
    expect(calls[0]?.body['reply_markup']).toEqual({ inline_keyboard: [] });
    await expect(c.editMessageText(1, 2, 'x')).rejects.toThrow(/not found/);
  });

  it('answers callbacks and parses getUpdates', async () => {
    const { fetch, calls } = fakeFetch([
      { body: { ok: true, result: true } },
      { body: { ok: true, result: [{ update_id: 9, message: { message_id: 1, chat: { id: 5 }, text: '/x' } }] } },
    ]);
    const c = new HttpBotClient({ token: TOKEN, fetch });
    await c.answerCallbackQuery('cb1', 'done');
    expect(calls[0]?.body).toEqual({ callback_query_id: 'cb1', text: 'done' });
    const ups = await c.getUpdates(10, 25);
    expect(ups[0]?.update_id).toBe(9);
    expect(calls[1]?.body).toMatchObject({ offset: 10, timeout: 25 });
  });

  it('never leaks the token in errors, stacks or JSON', async () => {
    const netErr = new Error(`connect failed to https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const { fetch } = fakeFetch([netErr, { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized for bot${TOKEN}` } }]);
    const c = new HttpBotClient({ token: TOKEN, fetch });
    for (let i = 0; i < 2; i++) {
      const err = (await c.sendMessage(1, 'x').catch((e: unknown) => e)) as TelegramError;
      expect(err).toBeInstanceOf(TelegramError);
      expect(err.message).not.toContain('SECRET');
      expect(String(err.stack)).not.toContain('SECRET');
      expect(JSON.stringify(err)).not.toContain('SECRET');
      expect(err.cause).toBeUndefined();
    }
    expect(JSON.stringify(c)).not.toContain('SECRET');
  });

  it('wraps network errors as status 0 and aborts getUpdates promptly', async () => {
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted by signal')));
      })) as unknown as typeof fetch;
    const c = new HttpBotClient({ token: TOKEN, fetch: f });
    const ac = new AbortController();
    const p = c.getUpdates(0, 30, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const net = fakeFetch([new Error('ECONNRESET')]);
    const err = (await new HttpBotClient({ token: TOKEN, fetch: net.fetch }).sendMessage(1, 'x').catch((e: unknown) => e)) as TelegramError;
    expect(err.status).toBe(0);
  });

  it('createHttpGateway builds one client per bot with its own token', async () => {
    const { fetch, calls } = fakeFetch([{ body: { ok: true, result: { message_id: 1 } } }]);
    const gw = createHttpGateway(tgConfig(), fetch);
    await gw.p0.sendMessage(1, 'a');
    await gw.p2.sendMessage(1, 'b');
    expect(calls[0]?.url).toContain('bot111111:AAAA-p0-token-secret');
    expect(calls[1]?.url).toContain('bot333333:CCCC-p2-token-secret');
  });
});

describe('FakeBotClient', () => {
  it('records sends with incrementing ids, edits and answers', async () => {
    const f = new FakeBotClient();
    expect((await f.sendMessage(1, 'a')).messageId).toBe(1);
    expect((await f.sendMessage(1, 'b', { keyboard: [[{ text: 'x', callbackData: 'y' }]] })).messageId).toBe(2);
    await f.editMessageText(1, 1, 'a2');
    await f.answerCallbackQuery('c', 'ok');
    expect(f.sent.map((s) => s.text)).toEqual(['a', 'b']);
    expect(f.edits[0]).toMatchObject({ messageId: 1, text: 'a2', keyboard: null });
    expect(f.answers[0]).toMatchObject({ callbackId: 'c', text: 'ok' });
  });

  it('failNext rejects the next n calls then recovers', async () => {
    const f = new FakeBotClient();
    f.failNext(2);
    await expect(f.sendMessage(1, 'a')).rejects.toBeInstanceOf(TelegramError);
    await expect(f.editMessageText(1, 1, 'a')).rejects.toBeInstanceOf(TelegramError);
    await expect(f.sendMessage(1, 'a')).resolves.toEqual({ messageId: 1 });
    expect(f.failedCalls).toBe(2);
  });

  it('pushUpdate feeds getUpdates, honours offset, and wakes a waiting poll', async () => {
    const f = new FakeBotClient();
    const waiting = f.getUpdates(0, 5);
    f.pushUpdate({ update_id: 1 });
    expect((await waiting).map((u) => u.update_id)).toEqual([1]);
    expect(await f.getUpdates(2, 0)).toEqual([]);
  });

  it('getUpdates aborts promptly', async () => {
    const f = new FakeBotClient();
    const ac = new AbortController();
    const p = f.getUpdates(0, 30, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('writes JSON lines in global call order across bots on flush', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tgfake-'));
    const file = path.join(dir, 'sub', 'sink.jsonl');
    const gw = makeFakeGateway(file);
    await gw.p0.sendMessage(1, 'one');
    await gw.p1.sendMessage(2, 'two');
    await gw.p0.editMessageText(1, 1, 'one!');
    gw.flush();
    await gw.p2.sendMessage(3, 'three');
    gw.flush();
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { bot: string; type: string; seq: number; text: string });
    expect(lines.map((l) => `${l.bot}:${l.type}:${l.text}`)).toEqual(['p0:send:one', 'p1:send:two', 'p0:edit:one!', 'p2:send:three']);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
  });
});
