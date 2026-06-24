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
export interface PlanFile {
  path: string;
  chainId: number;
  safeAddress: string;
  callsCount: number;
  modifierAddress?: string;
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
  };
  return {
    path,
    chainId: json.chainId,
    safeAddress: json.safeAddress,
    callsCount: json.callsCount ?? (Array.isArray(json.calls) ? json.calls.length : 0),
    modifierAddress: json.modifierAddress,
  };
}

/**
 * Parse the per-Safe proposal records from `zac submit` stdout. Each bundled
 * submit emits one line:
 *   submitted safe=0x… chain=1 plans=N calls=N nonce=N operation=N safeTxHash=0x… messageHash=0x…
 * The safeTxHash / messageHash here are the authoritative signing hashes
 * (built against the live Safe) that the plan JSON deliberately omits.
 */
export function parseSubmitLog(log: string): SubmitRecord[] {
  const out: SubmitRecord[] = [];
  for (const line of log.split('\n')) {
    if (!line.startsWith('submitted safe=')) continue;
    const field = (k: string): string | undefined =>
      line.match(new RegExp(`(?:^|\\s)${k}=(\\S+)`))?.[1];
    const safeAddress = field('safe');
    const chainId = field('chain');
    const safeTxHash = field('safeTxHash');
    if (safeAddress === undefined || chainId === undefined || safeTxHash === undefined) continue;
    out.push({
      safeAddress,
      chainId: Number(chainId),
      callsCount: Number(field('calls') ?? '0'),
      nonce: field('nonce') ?? '',
      operation: Number(field('operation') ?? '0'),
      safeTxHash,
      messageHash: field('messageHash') ?? '',
    });
  }
  return out;
}

/** Stable order: chainId asc, then safeAddress (lowercased) asc. */
export function sortPlans<T extends { chainId: number; safeAddress: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => {
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    return a.safeAddress.toLowerCase() < b.safeAddress.toLowerCase() ? -1 : 1;
  });
}
