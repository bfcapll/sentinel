import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('holdings are configuration, not code (PLAN.md §1.5)', () => {
  it('watcher and position source files contain no 20-byte protocol addresses', () => {
    const files = ['src/watchers', 'src/position', 'src/rules', 'src/alerts'].flatMap((d) =>
      readdirSync(d).filter((f) => f.endsWith('.ts')).map((f) => `${d}/${f}`),
    );
    for (const f of files) {
      // The zero address is a sentinel value, not a protocol address.
      const hits = (readFileSync(f, 'utf8').match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) ?? []).filter((a) => !/^0x0{40}$/.test(a));
      expect({ file: f, hits }).toEqual({ file: f, hits: [] });
    }
  });
});
