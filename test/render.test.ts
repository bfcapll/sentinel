import { describe, expect, it } from 'vitest';
import { formatUsd, renderAcked, renderAlert, renderResolved, renderSuperseded } from '../src/alerts/render.js';
import type { RenderInput } from '../src/alerts/render.js';

const EXPLORER = {
  tx_url: 'https://etherscan.io/tx/{hash}',
  block_url: 'https://etherscan.io/block/{number}',
  address_url: 'https://etherscan.io/address/{address}',
};
const HASH = '0x' + 'ab'.repeat(32);

function input(over: Partial<RenderInput> = {}): RenderInput {
  return {
    tier: 'P0',
    isOps: false,
    holding: 'steakhouse-usdc',
    conditionKey: 'steakhouse-usdc/proxy/impl-slot',
    alertId: 17,
    kind: 'open',
    exposureUsd: 123_456.78,
    exposureNote: 'main: 123,456.78 steakUSDC',
    exitPathOpen: true,
    exitPathReason: 'maxWithdraw covers position',
    context: {
      title: 'Implementation slot changed',
      detail: '0x1111 -> 0x2222',
      decoded: 'upgradeTo(0x2222)',
      txHash: HASH as `0x${string}`,
      block: 21_000_123,
      eta: 1_760_000_000,
    },
    explorer: EXPLORER,
    timezone: 'America/New_York',
    ...over,
  };
}

/** The mandatory fields, asserted for any rendering. */
function expectMandatory(out: string): void {
  expect(out).toMatch(/Holding: /);
  expect(out).toMatch(/\$ exposure: /);
  expect(out).toMatch(/Exit path: (OPEN|CLOSED|UNKNOWN)/);
  expect(out).toMatch(/Action: /);
  expect(out).toMatch(/Tx: /);
  expect(out).toMatch(/Block: /);
  expect(out).toMatch(/ETA: /);
  expect(out).toMatch(/alert #/);
  expect(out.length).toBeLessThanOrEqual(4000);
}

describe('formatUsd', () => {
  it('formats with grouping and two decimals', () => {
    expect(formatUsd(123_456.789)).toBe('$123,456.79');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(5)).toBe('$5.00');
    expect(formatUsd(-12.5)).toBe('-$12.50');
    expect(formatUsd(-0.001)).toBe('$0.00');
  });
  it('says unknown for null and non-finite', () => {
    expect(formatUsd(null)).toBe('unknown');
    expect(formatUsd(Number.NaN)).toBe('unknown');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});

describe('renderAlert mandatory fields', () => {
  it('P0 with tx, eta and exposure shows everything', () => {
    const out = renderAlert(input());
    expectMandatory(out);
    expect(out).toContain('🔴 <b>P0</b>');
    expect(out).toContain('<b>Implementation slot changed</b>');
    expect(out).toContain('Holding: <code>steakhouse-usdc</code>');
    expect(out).toContain('$ exposure: $123,456.78 (main: 123,456.78 steakUSDC)');
    expect(out).toContain('Exit path: OPEN</b> — maxWithdraw covers position');
    expect(out).toContain('Action: upgradeTo(0x2222)');
    expect(out).toContain(`<a href="https://etherscan.io/tx/${HASH}">`);
    expect(out).toContain('<a href="https://etherscan.io/block/21000123">21000123</a>');
    expect(out).toContain('ETA: 2025-10-09 08:53 UTC / 2025-10-09 04:53 EDT (America/New_York)');
    expect(out).toContain('Detail: 0x1111 -&gt; 0x2222');
    expect(out).toContain('alert #17 · <code>steakhouse-usdc/proxy/impl-slot</code>');
  });

  it('P1 and P2 badges', () => {
    expect(renderAlert(input({ tier: 'P1' }))).toContain('🟠 <b>P1</b>');
    expect(renderAlert(input({ tier: 'P2' }))).toContain('🟡 <b>P2</b>');
  });

  it('ops alerts are prefixed OPS', () => {
    const out = renderAlert(input({ tier: 'P1', isOps: true }));
    expect(out).toContain('🟠 <b>OPS P1</b>');
    expectMandatory(out);
    expect(renderAlert(input({ tier: 'P0', isOps: true }))).toContain('🔴 <b>OPS P0</b>');
  });

  it('states unknowns explicitly when tx, eta, exposure, decoded and block are absent', () => {
    const out = renderAlert(
      input({
        exposureUsd: null,
        exposureNote: undefined,
        exitPathOpen: null,
        exitPathReason: 'position not readable',
        context: { title: 'Oracle stale' },
        alertId: undefined,
      }),
    );
    expectMandatory(out);
    expect(out).toContain('$ exposure: unknown');
    expect(out).toContain('Exit path: UNKNOWN</b> (position not readable)');
    expect(out).toContain('Action: n/a (state-read detection)');
    expect(out).toContain('Tx: no tx (detected by state read)');
    expect(out).toContain('Block: unknown');
    expect(out).toContain('ETA: n/a');
    expect(out).toContain('alert #?');
    expect(out).not.toContain('Detail:');
  });

  it('renders CLOSED exit path', () => {
    const out = renderAlert(input({ exitPathOpen: false, exitPathReason: 'USDC paused' }));
    expect(out).toContain('Exit path: CLOSED</b> — USDC paused');
  });

  it('supplies a reason word when the caller gives an empty one', () => {
    expect(renderAlert(input({ exitPathReason: '  ' }))).toContain('Exit path: OPEN</b> — no reason given');
  });

  it('marks escalations and repeats', () => {
    expect(renderAlert(input({ kind: 'escalation' }))).toContain('⬆️ escalated');
    expect(renderAlert(input({ repeatCount: 3 }))).toContain('🔁 repeat #3');
  });

  it('shows the eta in UTC and in the local zone', () => {
    const out = renderAlert(input({ timezone: 'Asia/Tokyo', context: { title: 't', eta: 1_760_000_000 } }));
    expect(out).toContain('ETA: 2025-10-09 08:53 UTC / 2025-10-09 17:53 GMT+9 (Asia/Tokyo)');
  });

  it("resolves timezone 'local' to the host zone without throwing", () => {
    expect(() => renderAlert(input({ timezone: 'local' }))).not.toThrow();
    expect(renderAlert(input({ timezone: 'Not/AZone' }))).toContain('(UTC)');
  });

  it('links the contract address when present', () => {
    const out = renderAlert(input({ context: { title: 't', address: '0xAbC0000000000000000000000000000000000001' } }));
    expect(out).toContain('https://etherscan.io/address/0xAbC0000000000000000000000000000000000001');
  });
});

describe('renderAlert HTML safety', () => {
  it('escapes & < > in every free-text field', () => {
    const out = renderAlert(
      input({
        holding: 'a<b>&c',
        conditionKey: 'k<1>&',
        exposureNote: 'n<&>',
        exitPathReason: 'r<script>&',
        context: { title: 'T<i>&amp;', detail: 'd<>&', decoded: 'f(<x>,&y)' },
      }),
    );
    expect(out).not.toMatch(/<script>|<i>|<x>/);
    expect(out).toContain('T&lt;i&gt;&amp;amp;');
    expect(out).toContain('d&lt;&gt;&amp;');
    expect(out).toContain('f(&lt;x&gt;,&amp;y)');
    expect(out).toContain('Holding: <code>a&lt;b&gt;&amp;c</code>');
    expect(out).toContain('r&lt;script&gt;&amp;');
  });

  it('escapes quotes in link attributes', () => {
    const out = renderAlert(input({ explorer: { ...EXPLORER, tx_url: 'https://x.test/tx/{hash}?a="1"&b=2' } }));
    expect(out).toContain('?a=&quot;1&quot;&amp;b=2');
  });
});

describe('renderAlert 4096 cap', () => {
  it('truncates huge detail and decoded with an ellipsis, keeping every mandatory line', () => {
    const out = renderAlert(
      input({ context: { title: 'T', detail: 'D'.repeat(9000), decoded: 'X'.repeat(9000), txHash: HASH as `0x${string}`, block: 5, eta: 1_760_000_000 } }),
    );
    expect(out.length).toBeLessThan(4096);
    expect(out.length).toBeLessThanOrEqual(4000);
    expectMandatory(out);
    expect(out).toContain('…');
    expect(out).toContain(HASH);
    expect(out).toContain('/block/5');
  });

  it('survives an escape-heavy payload (every char expands to 5)', () => {
    const out = renderAlert(input({ context: { title: '&'.repeat(2000), detail: '&'.repeat(5000), decoded: '<'.repeat(5000) } }));
    expect(out.length).toBeLessThanOrEqual(4000);
    expectMandatory(out);
    // no half-escaped entity at the cut
    expect(out).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
  });

  it('truncates only detail when decoded is short', () => {
    const out = renderAlert(input({ context: { title: 'T', decoded: 'short()', detail: 'z'.repeat(8000) } }));
    expect(out).toContain('Action: short()');
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  it('leaves normal alerts untouched', () => {
    const out = renderAlert(input());
    expect(out).toContain('Action: upgradeTo(0x2222)\n');
    expect(out).toContain('Detail: 0x1111 -&gt; 0x2222\n');
  });
});

describe('renderResolved / renderSuperseded / renderAcked', () => {
  it('renders the resolution with reason and times', () => {
    const out = renderResolved({
      holding: 'h<1>',
      conditionKey: 'h/k',
      reason: 'slot restored & verified',
      tier: 'P0',
      resolvedAt: 1_760_000_000,
      timezone: 'America/New_York',
    });
    expect(out).toContain('✅ <b>RESOLVED</b>');
    expect(out).toContain('h&lt;1&gt;');
    expect(out).toContain('slot restored &amp; verified');
    expect(out).toContain('2025-10-09 04:53 EDT');
  });

  it('renders superseded with and without a successor', () => {
    expect(renderSuperseded(5)).toContain('alert #5');
    expect(renderSuperseded(5, 9)).toContain('replaced by alert #9');
  });

  it('appends an ACK line to the original text', () => {
    const base = renderAlert(input());
    const out = renderAcked(base, '@lan<don>', 1_760_000_000, 'UTC');
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain('✅ <b>ACK</b> by @lan&lt;don&gt; at 2025-10-09 08:53 UTC');
    expect(out.length).toBeLessThanOrEqual(4096);
  });
});
