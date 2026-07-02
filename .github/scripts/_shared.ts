/**
 * Shared helpers for the PR-comment and release-body builders.
 *
 * `zac plan` writes pure calldata (`*.plan.json`) — no safeTxHash / messageHash,
 * because those are built against the live Safe (incl. nonce) only at SUBMIT
 * time. So:
 *   - the PR-comment builder (plan stage) reads `*.plan.json` via `parsePlan`
 *     and shows NO hashes;
 *   - the release-body builder (submit stage) reads the authoritative
 *     safeTxHash / messageHash from `zac submit` stdout via `parseSubmitLog`.
 * The chain-label / sorting / link helpers are shared.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Chain ID → human label. Extend as the template grows.
export const CHAIN_NAMES: Record<number, string> = {
  1: 'mainnet',
  10: 'optimism',
  56: 'bnb',
  100: 'gnosis',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avalanche',
  11155111: 'sepolia',
};

// Safe-app shortname per chain — used in deep-link URLs.
// https://help.safe.global/en/articles/4773829-what-are-the-safe-shortnames
export const CHAIN_SHORTNAMES: Record<number, string> = {
  1: 'eth',
  10: 'oeth',
  56: 'bnb',
  100: 'gno',
  137: 'matic',
  8453: 'base',
  42161: 'arb1',
  43114: 'avax',
  11155111: 'sep',
};

// What `zac plan` actually writes (zac planSchema.ts): pure calldata, with
// NO safeTxData / safeTxHash / nonce / operation — those are built against
// the live Safe at SUBMIT time, so they only exist in the submit log.
// `nestedSigners` (optional) is metadata only: the lowercased addresses of
// Safe owners that are THEMSELVES Safes. The message hash each one must sign
// is nonce-derived, so it is NOT persisted here — it is previewed live in the
// `zac plan` diff and emitted authoritatively in the submit log.
export interface PlanFile {
  path: string;
  chainId: number;
  safeAddress: string;
  callsCount: number;
  modifierAddress?: string;
  nestedSigners?: string[];
}

/**
 * One nested signer, parsed from a `nested-signer …` line of `zac submit`
 * stdout. The child Safe (an owner of the parent) approves by executing
 * `parentSafe.approveHash(...)`; its OWN owners sign that child transaction, so
 * these are the child `SafeTx` hashes a Ledger shows: `domainHash` / `messageHash`
 * are the "Domain hash" / "Message hash", `safeTxHash` is the final child tx
 * digest, and `nonce` is the child Safe's nonce the hashes were computed at.
 */
export interface NestedSignerRecord {
  child: string;
  nonce: string;
  domainHash: string;
  messageHash: string;
  safeTxHash: string;
}

/** One posted Safe proposal, parsed from `zac submit` stdout. */
export interface SubmitRecord {
  safeAddress: string;
  chainId: number;
  callsCount: number;
  nonce: string;
  operation: number;
  safeTxHash: string;
  messageHash: string;
  /** Parent Safe's EIP-712 domain hash (from the `main-tx …` line), if present. */
  domainHash?: string;
  /** Nested signers (from `nested-signer …` lines), empty when none declared. */
  nestedSigners: NestedSignerRecord[];
}

export function walkPlans(root: string): string[] {
  const out: string[] = [];
  function rec(dir: string): void {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // best-effort
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) rec(p);
      else if (entry.name.endsWith('.plan.json')) out.push(p);
    }
  }
  rec(root);
  return out.sort();
}

export function shortAddr(addr: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function chainLabel(chainId: number): string {
  const name = CHAIN_NAMES[chainId];
  return name === undefined ? `chainId ${chainId}` : `${name} (${chainId})`;
}

export function safeAppLink(chainId: number, safeAddress: string, safeTxHash: string): string {
  const short = CHAIN_SHORTNAMES[chainId];
  if (short === undefined) return ''; // unknown chain → no link
  return `https://app.safe.global/transactions/tx?safe=${short}:${safeAddress}&id=multisig_${safeAddress}_${safeTxHash}`;
}

export function parsePlan(path: string): PlanFile {
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    chainId: number;
    safeAddress: string;
    callsCount?: number;
    calls?: unknown[];
    modifierAddress?: string;
    nestedSigners?: string[];
  };
  return {
    path,
    chainId: json.chainId,
    safeAddress: json.safeAddress,
    callsCount: json.callsCount ?? (Array.isArray(json.calls) ? json.calls.length : 0),
    modifierAddress: json.modifierAddress,
    ...(Array.isArray(json.nestedSigners) && json.nestedSigners.length > 0
      ? { nestedSigners: json.nestedSigners }
      : {}),
  };
}

/** Extract a `key=value` (non-space value) field from a submit-log line. */
function logField(line: string, key: string): string | undefined {
  return line.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`))?.[1];
}

/**
 * Parse the per-Safe proposal records from `zac submit` stdout. Each bundled
 * submit emits one line:
 *   submitted safe=0x… chain=1 plans=N calls=N nonce=N operation=N safeTxHash=0x… messageHash=0x…
 * The safeTxHash / messageHash here are the authoritative signing hashes
 * (built against the live Safe) that the plan JSON deliberately omits.
 *
 * When the Safe declares `nested_signers`, submit additionally emits, right
 * after the `submitted` line, one `main-tx …` line (parent Safe domain hash)
 * and one `nested-signer …` line per child Safe. Each child approves the parent
 * tx by executing `approveHash(...)`, so its line carries the CHILD SafeTx
 * hashes it must sign: `nonce=`, `domainHash=`, `messageHash=`, `safeTxHash=`.
 * Those are matched back to their `submitted` record by `(safe, chain)`, so
 * line ordering is not relied upon.
 */
export function parseSubmitLog(log: string): SubmitRecord[] {
  const byKey = new Map<string, SubmitRecord>();
  const order: string[] = [];
  const keyOf = (safe: string, chain: string): string => `${safe.toLowerCase()}:${chain}`;

  for (const line of log.split('\n')) {
    if (line.startsWith('submitted safe=')) {
      const safeAddress = logField(line, 'safe');
      const chainId = logField(line, 'chain');
      const safeTxHash = logField(line, 'safeTxHash');
      if (safeAddress === undefined || chainId === undefined || safeTxHash === undefined) continue;
      const key = keyOf(safeAddress, chainId);
      if (byKey.has(key)) continue; // one bundled proposal per (safe, chain)
      order.push(key);
      byKey.set(key, {
        safeAddress,
        chainId: Number(chainId),
        callsCount: Number(logField(line, 'calls') ?? '0'),
        nonce: logField(line, 'nonce') ?? '',
        operation: Number(logField(line, 'operation') ?? '0'),
        safeTxHash,
        messageHash: logField(line, 'messageHash') ?? '',
        nestedSigners: [],
      });
    } else if (line.startsWith('main-tx safe=')) {
      const safeAddress = logField(line, 'safe');
      const chainId = logField(line, 'chain');
      if (safeAddress === undefined || chainId === undefined) continue;
      const rec = byKey.get(keyOf(safeAddress, chainId));
      const domainHash = logField(line, 'domainHash');
      if (rec !== undefined && domainHash !== undefined) rec.domainHash = domainHash;
    } else if (line.startsWith('nested-signer safe=')) {
      const safeAddress = logField(line, 'safe');
      const chainId = logField(line, 'chain');
      const child = logField(line, 'child');
      if (safeAddress === undefined || chainId === undefined || child === undefined) continue;
      const rec = byKey.get(keyOf(safeAddress, chainId));
      if (rec === undefined) continue;
      rec.nestedSigners.push({
        child,
        nonce: logField(line, 'nonce') ?? '',
        domainHash: logField(line, 'domainHash') ?? '',
        messageHash: logField(line, 'messageHash') ?? '',
        safeTxHash: logField(line, 'safeTxHash') ?? '',
      });
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/** Stable order: chainId asc, then safeAddress (lowercased) asc. */
export function sortPlans<T extends { chainId: number; safeAddress: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => {
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    return a.safeAddress.toLowerCase() < b.safeAddress.toLowerCase() ? -1 : 1;
  });
}
