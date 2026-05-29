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
 * `(chainId, safeAddress)` group gets its own row in the summary +
 * hashes tables, sorted by chainId asc then safeAddress.
 */

import { readFileSync } from 'node:fs';
import {
  chainLabel,
  parsePlan,
  safeAppLink,
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
        `| \`${shortAddr(p.safeAddress)}\` | ${chainLabel(p.chainId)} | ${p.callsCount} | ${p.nonce} |`,
    )
    .join('\n');

  const hashRows = sorted
    .map((p) => {
      const link = safeAppLink(p.chainId, p.safeAddress, p.safeTxHash);
      const hashCell =
        link === '' ? `\`${p.safeTxHash}\`` : `[\`${p.safeTxHash}\`](${link})`;
      return `| \`${shortAddr(p.safeAddress)}\` | ${chainLabel(p.chainId)} | ${hashCell} | \`${p.messageHash}\` |`;
    })
    .join('\n');

  return [
    '### 🤖 zac plan',
    '',
    `**${safes.size} safe${safes.size === 1 ? '' : 's'} across ${chains.size} chain${chains.size === 1 ? '' : 's'}** will be updated when this PR merges.`,
    '',
    '<details open><summary><b>Summary</b></summary>',
    '',
    '| Safe | Chain | Calls | Nonce |',
    '|------|-------|-------|-------|',
    summaryRows,
    '',
    '</details>',
    '',
    '<details><summary><b>Hashes to verify on signing</b></summary>',
    '',
    '> When signing in the Safe app, your hardware wallet should display these exact hashes.',
    '',
    '| Safe | Chain | safeTxHash | messageHash |',
    '|------|-------|------------|-------------|',
    hashRows,
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
