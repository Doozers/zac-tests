# zac-template

Template for managing Safe role configurations as code. Powered by
[zac](https://github.com/railnetorg/zac) (the CLI vendored here as a
submodule) and GitHub Actions.

On a PR touching `config/`, the **plan** workflow posts a sticky
comment showing every role change that would land on-chain — full
diff, per-Safe `safeTxHash`, `messageHash` (the inner EIP-712 struct
hash hardware wallets display), and a deep link to sign in the Safe
app. On merge to `main`, the **release** workflow signs each plan
with a proposer EOA, posts proposals to Safe Transaction Service, and
cuts a GitHub Release tagged with `safe-<merge-sha>` whose body
records the exact hashes plus the plan JSONs as assets.

> ⚠️ Nothing executes on-chain automatically. The release workflow
> only proposes; owners co-sign and execute through the Safe app.

## Layout

```
.
├── zac/                            git submodule — zac CLI + templates
├── config.yaml                     alias registry (per-network)
├── aliases/
│   ├── signers.yaml                role-member EOAs (global)
│   ├── mainnet/
│   │   ├── safes.yaml              your Safe addresses
│   │   └── modifiers.yaml          your Zodiac Roles modifier addresses
│   ├── base/                       (same pattern per network)
│   └── sepolia/
├── config/                         deployment sources (one `.zac.yaml` per role bundle)
│   └── <network>/<safe-address>/<name>.zac.yaml
├── .github/
│   ├── workflows/{plan,release}.yml
│   └── scripts/                    PR-comment + release-body builders (Bun + viem)
├── package.json + bun.lock         pin viem for the comment/body builders
└── .gitignore
```

## Prerequisites

You need an existing **Safe** (1+ owners) with a **Zodiac Roles
modifier v2** installed. Deploy via
[app.safe.global](https://app.safe.global) → Apps → Zodiac → Roles
Modifier. The modifier address goes into
`aliases/<network>/modifiers.yaml`.

You also need an EOA — the **proposer** — that is either:
- an owner of the Safe, or
- registered as a proposer on Safe Transaction Service for that Safe
  (`POST /api/v2/safes/<safe>/proposers/`).

The proposer signs `safeTxHash`es so Safe Tx Service accepts them; it
does NOT execute anything on-chain.

## Setup

```bash
# 1. Use this repo as a template (gh: "Use this template" → new repo),
#    or clone it directly.
git clone <your-fork> && cd <your-fork>

# 2. Pull in the zac submodule.
git submodule update --init --recursive

# 3. Install the zac CLI's dependencies + viem for the comment script.
(cd zac/action && bun install)
bun install
```

## Configure your deployment

### 1. Aliases

Populate these three files with real addresses for each network you
target:

- `aliases/signers.yaml` — `member_name: "0x…"` for every role member.
- `aliases/<network>/safes.yaml` — `safe_name: "0x…"` (checksummed).
- `aliases/<network>/modifiers.yaml` — `modifier_name: "0x…"`.

Skip a network entirely by leaving its files empty.

### 2. A `.zac.yaml` per Safe

Create one `*.zac.yaml` per role configuration under
`config/<network>/<safe-address>/`. The directory name must match
(case-insensitive) the rendered `safe_address`. Example:

```yaml
# config/mainnet/0x40FF…dE58/aave_v3.zac.yaml
roles_modifier_address: "{{ aliases.modifiers.my_modifier }}"
safe_address: "{{ aliases.safes.my_safe }}"
chain_id: 1
name: AAVE V3 USDC Manager
description: Supply / withdraw USDC on Aave V3 mainnet
configs:
  - template: "../../../zac/templates/aave_v3/aave_v3.tmpl"
    key: AAVE_V3
    members:
      - "{{ aliases.signers.alice }}"
    params:
      deposit_assets:
        - address: "{{ aliases.tokens.USDC }}"
```

The available templates live under `zac/templates/<protocol>/`. Each
template's header comments document the params it expects.

### 3. Wire it in `config.yaml`

The repo ships with mainnet / base / sepolia namespaces pre-declared.
Add or remove protocol aliases per network as your templates need —
the canonical set is in `zac/aliases/<network>/`.

## Repo secrets

In your fork's **Settings → Secrets and variables → Actions**, add:

| Secret | Required? | What it is |
|---|---|---|
| `<NETWORK>_RPC_URL` (e.g. `MAINNET_RPC_URL`) | yes, per network you target | RPC endpoint zac plan + Safe SDK use. Public RPCs rate-limit on deeply nested role configs — prefer Alchemy / Infura / your own node. |
| `ZAC_PROPOSER_PRIVATE_KEY` | yes | 0x-prefixed key for the proposer EOA. Used only by the release workflow. |
| `ZAC_SUBMODULE_TOKEN` | recommended | Fine-grained GitHub PAT with read access to `railnetorg/zac` (the submodule). Required when the repo's default `GITHUB_TOKEN` can't reach the submodule across org boundaries. Falls back to `GITHUB_TOKEN` if unset. |
| `SAFE_API_KEY` | optional | Only when Safe Transaction Service falls back to `api.safe.global` for your chain. |

## Workflow lifecycle

```
┌────────────┐                  ┌──────────────────────┐
│  Open PR   │ ───plan.yml───►  │ Sticky PR comment    │
│ (config/)  │                  │  – diff              │
└────────────┘                  │  – safeTxHash        │
                                │  – messageHash       │
                                │  – Safe-app link     │
                                └──────────────────────┘
       │ merge
       ▼
┌────────────┐                  ┌──────────────────────┐
│ Push main  │ ──release.yml──► │ Safe Tx Service      │
│ (config/)  │                  │  – proposal queued   │
└────────────┘                  └──────────────────────┘
                                ┌──────────────────────┐
                                │ GitHub Release       │
                                │  tag safe-<sha>      │
                                │  body + plan.json    │
                                └──────────────────────┘
                                          │
                                          ▼
                                 Owners co-sign + execute
                                 in the Safe app.
```

`plan` triggers on PRs touching `config/**`, `zac`,
`.github/workflows/plan.yml`, or `.github/scripts/**`. Same for
`release` (on push to `main`). An in-sync push is a clean no-op — the
release step is gated on at least one `*.plan.json` being emitted.

## Multi-chain

A single push can touch multiple chains / multiple Safes. Both
workflows enumerate every emitted plan and group by
`(chainId, safeAddress)`, producing one section per group in the PR
comment and the release body. Per-chain RPCs are read via
`<NETWORK>_RPC_URL`, falling back to `RPC_URL`.

## Updating zac

```bash
git -C zac fetch origin
git -C zac checkout <new-ref>
git add zac && git commit -m "chore(zac): bump submodule to <new-ref>"
```

Both workflows are path-filtered to fire on submodule pointer bumps,
so the next PR / merge after a bump will re-plan against the new zac.

## Troubleshooting

- **Submodule clone fails with 403 in CI.** Your `ZAC_SUBMODULE_TOKEN`
  PAT needs read access to both this repo and `railnetorg/zac`.
  Repository perms: Contents = Read.
- **`zac plan` hangs or times out.** Public RPCs throttle on deeply
  nested role configs (ondo_gm in particular). Use a real RPC for
  affected chains.
- **Safe Tx Service rejects the proposal with "Checksum address
  validation failed".** Fixed in zac ≥ 84c8e10 — bump the submodule.
- **Release fails with "branch or tag names consisting of 40 or 64
  hex characters are not allowed".** Tag must not be a bare 40-char
  SHA; this template prefixes with `safe-` already. If you forked
  before that fix, sync `.github/workflows/release.yml` from upstream.
- **Plan shows unexpected revokes.** The workflow runs with the zac
  CLI default (`--revoke-unmentioned=false`), which only touches
  roles declared in `config/`. To deliberately revoke an on-chain
  role, leave its `.zac.yaml` in place but flip the flag in
  `.github/workflows/{plan,release}.yml`.
