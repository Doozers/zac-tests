#!/usr/bin/env bun
/**
 * Render a sticky PR comment body summarizing `zac plan` output.
 *
 * Inputs (positional):
 *   1. plan-diff.txt — captured stdout from `zac plan` (the human-readable
 *      `printPlanDiff` output, possibly multiple `plan:` sections when
 *      multiple safe-dirs were planned).
 *   2. config-root — root directory to walk for `*.plan.json` artifacts.
 *
 * Writes the markdown body to stdout. The workflow redirects to
 * `pr-comment.md` and passes that to `marocchino/sticky-pull-request-comment`.
 *
 * Multi-chain / multi-safe in one PR is a first-class case: every
 * `(chainId, safeAddress)` group gets its own row in the summary table,
 * sorted by chainId asc then safeAddress.
 *
 * NOTE: the summary table intentionally omits per-plan safeTxHash /
 * messageHash. The Safe txs in a PR are the pre-bundle plans — they get
 * re-bundled (and re-hashed) at release time when multiple plans for the
 * same `(chainId, safeAddress)` collapse into one Safe transaction. Showing
 * pre-bundle hashes as authoritative would mislead signers. The authoritative
 * signing hashes live in the release workflow's body (`build-release-body.ts`).
 *
 * The embedded **Plan diff** (raw `zac plan` stdout) DOES include the live
 * nested-signer preview — the Domain hash / Message hash / final digest at the
 * CURRENT nonce, to be re-verified against the release body after merge. When
 * any plan declares nested signers we add a short callout pointing signers to
 * that block.
 */

import { readFileSync } from 'node:fs';
import {
  chainLabel,
  parsePlan,
  shortAddr,
  sortPlans,
  walkPlans,
  type PlanFile,
} from './_shared';

function renderEmpty(headSha: string): string {
  return [
    '### 🤖 zac plan',
    '',
    '**No changes** — Safe state matches `config/`.',
    '',
    `> Generated from \`${headSha.slice(0, 7)}\`. Push to update.`,
    '',
  ].join('\n');
}

function renderBody(plans: PlanFile[], diff: string, headSha: string): string {
  const sorted = sortPlans(plans);

  const chains = new Set(sorted.map((p) => p.chainId));
  const safes = new Set(sorted.map((p) => `${p.chainId}:${p.safeAddress.toLowerCase()}`));

  const summaryRows = sorted
    .map(
      (p) =>
        `| \`${shortAddr(p.safeAddress)}\` | ${chainLabel(p.chainId)} | ${p.callsCount} | ${p.nestedSigners?.length ?? 0} |`,
    )
    .join('\n');

  // Nested-signer callout — some Safe owners are themselves Safes; their
  // signers sign a message hash on the CHILD Safe. The hashes are previewed
  // (at the current nonce) inside the Plan diff below and are authoritative in
  // the release body after merge.
  const nestedTotal = sorted.reduce((n, p) => n + (p.nestedSigners?.length ?? 0), 0);
  const nestedCallout =
    nestedTotal > 0
      ? [
          '',
          `> 🔗 **${nestedTotal} nested signer${nestedTotal === 1 ? '' : 's'}** — one or more Safe owners are themselves Safes. The message hash their signers must sign **on the child Safe** is previewed in the **Plan diff** below (at the current nonce — re-verify against the release notes after merge).`,
        ]
      : [];

  return [
    '### 🤖 zac plan',
    '',
    `**${safes.size} safe${safes.size === 1 ? '' : 's'} across ${chains.size} chain${chains.size === 1 ? '' : 's'}** will be updated when this PR merges.`,
    ...nestedCallout,
    '',
    '<details open><summary><b>Summary</b></summary>',
    '',
    '| Safe | Chain | Calls | Nested signers |',
    '|------|-------|-------|----------------|',
    summaryRows,
    '',
    '</details>',
    '',
    '<details><summary><b>Plan diff</b></summary>',
    '',
    '```',
    diff.trim(),
    '```',
    '',
    '</details>',
    '',
    `> Generated from \`${headSha.slice(0, 7)}\`. Push to update.`,
    '',
  ].join('\n');
}

function main(): void {
  const [diffPath, configRoot] = process.argv.slice(2);
  if (diffPath === undefined || configRoot === undefined) {
    process.stderr.write('usage: build-pr-comment.ts <plan-diff.txt> <config-root>\n');
    process.exit(2);
  }
  const headSha = process.env['PR_HEAD_SHA'] ?? '0000000';
  const diff = readFileSync(diffPath, 'utf8');
  const planPaths = walkPlans(configRoot);
  if (planPaths.length === 0) {
    process.stdout.write(renderEmpty(headSha));
    return;
  }
  const plans = planPaths.map(parsePlan);
  process.stdout.write(renderBody(plans, diff, headSha));
}

main();
