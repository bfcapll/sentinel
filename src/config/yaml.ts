import { readFileSync } from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument, visit, type Document, type Node } from 'yaml';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ConfigIssue {
  file: string;
  path: string;
  message: string;
  kind: 'placeholder' | 'env' | 'ref' | 'schema' | 'cross' | 'io' | 'verify';
}

export function formatPath(path: ReadonlyArray<string | number>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out || '(root)';
}

export interface RawYaml {
  file: string;
  doc: Document;
  data: Json;
}

export function readYaml(file: string): RawYaml {
  const text = readFileSync(file, 'utf8');
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new Error(`${file}: YAML parse error: ${doc.errors.map((e) => e.message).join('; ')}`);
  }
  // YAML 1.2 reads an unquoted 0x… address as a (precision-losing) hex integer. Config values are
  // data, not numbers: take the source text of every hex scalar. A second parse keeps `doc`
  // pristine so `config discover` can rewrite the file without re-quoting addresses.
  const typed = parseDocument(text);
  visit(typed, {
    Scalar(_key, node) {
      if (node.format === 'HEX' && typeof node.source === 'string') node.value = node.source;
    },
  });
  return { file, doc, data: (typed.toJS() ?? {}) as Json };
}

/** Paths of nodes carrying a `# verify` comment (trailing or leading). */
export function verifyMarks(doc: Document): string[] {
  const out: string[] = [];
  const has = (c: string | null | undefined): boolean => !!c && /\bverify\b/i.test(c);
  const walk = (node: unknown, path: Array<string | number>): void => {
    if (node === null || node === undefined) return;
    const n = node as Node;
    if (has((n as { comment?: string }).comment) || has((n as { commentBefore?: string }).commentBefore)) {
      out.push(formatPath(path));
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        if (isScalar(pair.key) && has(pair.key.comment)) out.push(formatPath([...path, key]));
        walk(pair.value, [...path, key]);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => walk(item, [...path, i]));
    }
  };
  walk(doc.contents, []);
  return [...new Set(out)];
}

/** Depth-first map over every string leaf; returns a new structure. */
export function mapStrings(v: Json, fn: (s: string, path: Array<string | number>) => Json, path: Array<string | number> = []): Json {
  if (typeof v === 'string') return fn(v, path);
  if (Array.isArray(v)) return v.map((x, i) => mapStrings(x, fn, [...path, i]));
  if (v && typeof v === 'object') {
    const o: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) o[k] = mapStrings(x, fn, [...path, k]);
    return o;
  }
  return v;
}

export function isObject(v: unknown): v is { [k: string]: Json } {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge; `over` wins. Arrays are replaced, not concatenated. */
export function deepMerge(base: Json, over: Json): Json {
  if (isObject(base) && isObject(over)) {
    const out: { [k: string]: Json } = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k] as Json, v) : v;
    return out;
  }
  return over;
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Substitute `${VAR}` / `${VAR:-default}` in a string. Unset or empty variables without
 * a default are reported by name only (never echo values: they are secrets).
 */
export function substituteEnv(s: string, env: NodeJS.ProcessEnv, missing: string[]): string {
  return s.replace(ENV_RE, (_m, name: string, dflt: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (dflt !== undefined) return dflt;
    missing.push(name);
    return '';
  });
}

const PLACEHOLDER_RES = [
  /^0x…/,
  /…/,
  /^0x\.\.\.$/,
  /^<[^<>]+>$/,
  /^(TODO|CHANGE_?ME|FIXME|PLACEHOLDER|REPLACE_?ME|YOUR_[A-Z_]+)\b/i,
];

export function isPlaceholder(s: string): boolean {
  return PLACEHOLDER_RES.some((re) => re.test(s.trim()));
}
