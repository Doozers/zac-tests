/**
 * Shared helpers for the PR-comment and release-body builders.
 *
 * Both scripts read the same `*.plan.json` artifacts emitted by
 * `zac plan` and compute the same EIP-712 `messageHash` for each one,
 * so the parsing + hashing + chain-label code lives here and the two
 * top-level scripts only differ in their markdown rendering.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashStruct } from 'viem';

// EIP-712 SafeTx struct definition — matches Safe contracts v1.3+ and
// what `Safe.getTransactionHash()` hashes under the per-chain domain
// separator. The `messageHash` we compute here is `keccak256(hashStruct
// (SafeTx))` — the inner struct hash a hardware wallet displays.
export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

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

export interface PlanFile {
  path: string;
  chainId: number;
  safeAddress: string;
  callsCount: number;
  safeTxHash: string;
  messageHash: string;
  nonce: string;
  operation: number;
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
  const raw = readFileSync(path, 'utf8');
  const json = JSON.parse(raw) as {
    chainId: number;
    safeAddress: string;
    callsCount: number;
    safeTxHash: string;
    safeTxData: {
      to: `0x${string}`;
      value: string;
      data: `0x${string}`;
      operation: number;
      safeTxGas: string;
      baseGas: string;
      gasPrice: string;
      gasToken: `0x${string}`;
      refundReceiver: `0x${string}`;
      nonce: number | string;
    };
  };
  const messageHash = hashStruct({
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    data: {
      to: json.safeTxData.to,
      value: BigInt(json.safeTxData.value),
      data: json.safeTxData.data,
      operation: json.safeTxData.operation,
      safeTxGas: BigInt(json.safeTxData.safeTxGas),
      baseGas: BigInt(json.safeTxData.baseGas),
      gasPrice: BigInt(json.safeTxData.gasPrice),
      gasToken: json.safeTxData.gasToken,
      refundReceiver: json.safeTxData.refundReceiver,
      nonce: BigInt(json.safeTxData.nonce),
    },
  });
  return {
    path,
    chainId: json.chainId,
    safeAddress: json.safeAddress,
    callsCount: json.callsCount,
    safeTxHash: json.safeTxHash,
    messageHash,
    nonce: String(json.safeTxData.nonce),
    operation: json.safeTxData.operation,
  };
}

/** Stable order: chainId asc, then safeAddress (lowercased) asc. */
export function sortPlans(plans: PlanFile[]): PlanFile[] {
  return plans.slice().sort((a, b) => {
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    return a.safeAddress.toLowerCase() < b.safeAddress.toLowerCase() ? -1 : 1;
  });
}
