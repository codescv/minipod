import { MiniPodError } from '../errors';
import type { EpisodeKey, HlcMs } from '../types';

/**
 * Base-62 digits ordered strictly by ASCII / UTF-16 code point (`0-9 < A-Z < a-z`),
 * guaranteeing JS `<`/`>` and SQLite `BINARY` collation sort identically.
 */
export const BASE62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const QUEUE_KEY_REBALANCE_LENGTH = 64;

const SMALLEST_INTEGER = 'A00000000000000000000000000';
const INTEGER_ZERO = 'a0';

function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') {
    return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  }
  if (head >= 'A' && head <= 'Z') {
    return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  }
  throw new MiniPodError('invalid-argument', `Invalid fractional-index key head: "${head}"`);
}

function getIntegerPart(key: string): string {
  const intPartLength = getIntegerLength(key[0]!);
  if (intPartLength > key.length) {
    throw new MiniPodError('invalid-argument', `Invalid fractional-index key: "${key}"`);
  }
  return key.slice(0, intPartLength);
}

export function validateOrderKey(key: string): void {
  if (key === SMALLEST_INTEGER) {
    throw new MiniPodError('invalid-argument', `Smallest fractional-index integer "${key}" cannot be decremented`);
  }
  const iPart = getIntegerPart(key);
  const fPart = key.slice(iPart.length);
  if (fPart.endsWith(BASE62_DIGITS[0]!)) {
    throw new MiniPodError('invalid-argument', `Fractional-index key "${key}" has trailing zero`);
  }
  for (let i = 1; i < key.length; i++) {
    if (!BASE62_DIGITS.includes(key[i]!)) {
      throw new MiniPodError('invalid-argument', `Invalid character in fractional-index key "${key}"`);
    }
  }
}

function incrementInteger(x: string): string | null {
  validateInteger(x);
  const head = x[0]!;
  const digs = x.slice(1).split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = BASE62_DIGITS.indexOf(digs[i]!) + 1;
    if (d === BASE62_DIGITS.length) {
      digs[i] = BASE62_DIGITS[0]!;
    } else {
      digs[i] = BASE62_DIGITS[d]!;
      carry = false;
    }
  }
  if (carry) {
    if (head === 'Z') {
      return INTEGER_ZERO;
    }
    if (head === 'z') {
      return null;
    }
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > 'a') {
      digs.push(BASE62_DIGITS[0]!);
    } else {
      digs.pop();
    }
    return h + digs.join('');
  }
  return head + digs.join('');
}

function decrementInteger(x: string): string | null {
  validateInteger(x);
  const head = x[0]!;
  const digs = x.slice(1).split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = BASE62_DIGITS.indexOf(digs[i]!) - 1;
    if (d === -1) {
      digs[i] = BASE62_DIGITS[BASE62_DIGITS.length - 1]!;
    } else {
      digs[i] = BASE62_DIGITS[d]!;
      borrow = false;
    }
  }
  if (borrow) {
    if (head === 'a') {
      return `Z${BASE62_DIGITS[BASE62_DIGITS.length - 1]!}`;
    }
    if (head === 'A') {
      return null;
    }
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < 'Z') {
      digs.push(BASE62_DIGITS[BASE62_DIGITS.length - 1]!);
    } else {
      digs.pop();
    }
    return h + digs.join('');
  }
  return head + digs.join('');
}

function validateInteger(int: string): void {
  if (int.length !== getIntegerLength(int[0]!)) {
    throw new MiniPodError('invalid-argument', `Invalid integer part of fractional-index key: "${int}"`);
  }
}

function midpoint(a: string, b: string | null | undefined): string {
  if (b !== null && b !== undefined && a >= b) {
    throw new MiniPodError('invalid-argument', `Fractional midpoint requires a < b, got "${a}" >= "${b}"`);
  }
  if (a.endsWith(BASE62_DIGITS[0]!) || (b && b.endsWith(BASE62_DIGITS[0]!))) {
    throw new MiniPodError('invalid-argument', 'Fractional part must not have trailing zero');
  }
  if (b) {
    let n = 0;
    while ((a[n] ?? BASE62_DIGITS[0]!) === b[n]) {
      n++;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
    }
  }

  const digitA = a ? BASE62_DIGITS.indexOf(a[0]!) : 0;
  const digitB = b ? BASE62_DIGITS.indexOf(b[0]!) : BASE62_DIGITS.length;
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return BASE62_DIGITS[midDigit]!;
  }
  if (b && b.length > 1) {
    return b.slice(0, 1);
  }
  return BASE62_DIGITS[digitA]! + midpoint(a.slice(1), null);
}

/**
 * Generates a Base-62 lexicographical fractional-index key strictly between `a` and `b`
 * (`a === null` -> before `b`; `b === null` -> after `a`; both `null` -> `'a0'`).
 *
 * Reference algorithm: Greenspan / Figma fractional-indexing (ARCHITECTURE.md §7.4).
 */
export function generateKeyBetween(
  a: string | null | undefined,
  b: string | null | undefined,
): string {
  if (a != null) validateOrderKey(a);
  if (b != null) validateOrderKey(b);
  if (a != null && b != null && a >= b) {
    throw new MiniPodError('invalid-argument', `generateKeyBetween requires a < b, got "${a}" >= "${b}"`);
  }

  if (a == null) {
    if (b == null) {
      return INTEGER_ZERO;
    }
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) {
      return ib + midpoint('', fb);
    }
    if (ib < b) {
      return ib;
    }
    const res = decrementInteger(ib);
    if (res === null) {
      throw new MiniPodError('invalid-argument', 'Fractional index range underflow');
    }
    return res;
  }

  if (b == null) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }

  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) {
    return ia + midpoint(fa, fb);
  }
  const i = incrementInteger(ia);
  if (i === null) {
    throw new MiniPodError('invalid-argument', 'Fractional index range overflow');
  }
  if (i < b) {
    return i;
  }
  return ia + midpoint(fa, null);
}

/**
 * Generates `n` strictly increasing fractional-index keys between `a` and `b`.
 */
export function generateNKeysBetween(
  a: string | null | undefined,
  b: string | null | undefined,
  n: number,
): string[] {
  if (n <= 0) return [];
  if (n === 1) return [generateKeyBetween(a, b)];
  if (b == null) {
    let cur = generateKeyBetween(a, b);
    const out = [cur];
    for (let i = 1; i < n; i++) {
      cur = generateKeyBetween(cur, b);
      out.push(cur);
    }
    return out;
  }
  if (a == null) {
    let cur = generateKeyBetween(a, b);
    const out = [cur];
    for (let i = 1; i < n; i++) {
      cur = generateKeyBetween(a, cur);
      out.push(cur);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = generateKeyBetween(a, b);
  return [
    ...generateNKeysBetween(a, c, mid),
    c,
    ...generateNKeysBetween(c, b, n - mid - 1),
  ];
}

export function needsKeyRebalance(pos: string): boolean {
  return pos.length > QUEUE_KEY_REBALANCE_LENGTH;
}

/**
 * Deterministic total order for queue entries (ARCHITECTURE.md §7.4):
 * `(pos, addedAt, episodeKey)`.
 */
export function compareQueueOrder(
  a: { readonly pos: string; readonly addedAt: HlcMs; readonly episodeKey: EpisodeKey },
  b: { readonly pos: string; readonly addedAt: HlcMs; readonly episodeKey: EpisodeKey },
): number {
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1;
  if (a.addedAt !== b.addedAt) return a.addedAt - b.addedAt;
  if (a.episodeKey !== b.episodeKey) return a.episodeKey < b.episodeKey ? -1 : 1;
  return 0;
}
