// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test, Vm} from "forge-std/Test.sol";

/// @notice Coinshares-ZAC fork-test base.
///
///         Subclasses call `zacApply(configPath)` from their `setUp`. The
///         helper:
///           1. Forks the chain via `RPC_URL` (must be an anvil RPC).
///           2. Runs `zac generate` + `zac plan` on the supplied config.
///              `generate` writes `<stem>.yaml` alongside the source;
///              `plan` writes `<stem>.plan.json` next to the generated YAML.
///           3. Impersonates the CS Safe via anvil cheats and replays each
///              planned call to apply the role state on the fork.
///
///         The CS Safe + Roles V2 modifier are already deployed on mainnet
///         (see `aliases/mainnet/safes.yaml` + `aliases/mainnet/modifiers.yaml`)
///         so there is NO need to deploy fresh infra in setUp — the helper
///         just applies the role config against the real cs_modifier.
///
/// @dev    `RPC_URL` must point at an anvil RPC because the helper uses
///         `anvil_*` cheats. The `just forge-test-fork` recipe handles
///         spawning anvil + exporting `RPC_URL`; see top-level justfile.
abstract contract CsForkTest is Test {
    /// @notice Generate the ZAC config, compute the plan, and execute each
    ///         planned call as the impersonated Safe on the active fork.
    /// @param configPath Path to the `.zac.yaml` source, relative to /foundry/.
    function zacApply(string memory configPath) internal {
        // Hard-fail if RPC_URL unset; we'd have nothing to talk to.
        vm.envString("RPC_URL");

        // Capture forge's pinned block BEFORE the eth_sendTransaction calls
        // advance anvil's tip.
        uint256 startBlock = block.number;

        // `zac generate` writes `<stem>.yaml` alongside the `.zac.yaml`
        // source; `zac plan` writes `<stem>.plan.json` alongside that.
        // No `--out` flag exists in the current CLI (removed by the
        // "directory-driven workflow" refactor); derive the plan path
        // locally so we can read it after `plan` runs.
        string memory planPath = string.concat(_stripZacSuffix(configPath), ".plan.json");

        // 1. zac generate -> flattened deployment YAML.
        string[] memory genCmd = new string[](4);
        genCmd[0] = "bun";
        genCmd[1] = "../zac/action/cli.ts";
        genCmd[2] = "generate";
        genCmd[3] = configPath;
        Vm.FfiResult memory r = vm.tryFfi(genCmd);
        if (r.exitCode != 0) {
            revert(string.concat("zac generate failed: ", string(r.stderr)));
        }

        // 2. zac plan -> JSON describing role-state-update calls.
        //    `plan` expects the `.zac.yaml` source and resolves its own
        //    sibling generated `<stem>.yaml`; passing the generated file
        //    directly is rejected at the load phase.
        string[] memory planCmd = new string[](4);
        planCmd[0] = "bun";
        planCmd[1] = "../zac/action/cli.ts";
        planCmd[2] = "plan";
        planCmd[3] = configPath;
        r = vm.tryFfi(planCmd);
        if (r.exitCode != 0) {
            revert(string.concat("zac plan failed: ", string(r.stderr)));
        }

        // If `plan` produced no `.plan.json`, the modifier is already in
        // sync with the .zac.yaml config — nothing to apply on the fork.
        // Skip the impersonation + replay and proceed to tests, which
        // exercise the on-chain role as it stands.
        if (!vm.exists(planPath)) {
            emit log("zac plan: in sync - no changes to apply on the fork");
            return;
        }

        // 3. Read plan; iterate each planned call.
        string memory planJson = vm.readFile(planPath);
        address planSafe = vm.parseJsonAddress(planJson, ".safeAddress");
        string memory safeStr = vm.toString(planSafe);

        // 4. Disable auto-mining, impersonate the Safe, queue each tx, then
        //    explicitly mine one block containing all of them.
        vm.rpc("evm_setAutomine", "[false]");
        vm.rpc("anvil_setBalance", string.concat("[\"", safeStr, "\",\"0x8ac7230489e80000\"]"));
        vm.rpc("anvil_impersonateAccount", string.concat("[\"", safeStr, "\"]"));

        uint256 callsCount = vm.parseJsonUint(planJson, ".callsCount");
        for (uint256 i = 0; i < callsCount; i++) {
            string memory base = string.concat(".calls[", vm.toString(i), "]");
            address to = vm.parseJsonAddress(planJson, string.concat(base, ".to"));
            bytes memory data = vm.parseJsonBytes(planJson, string.concat(base, ".data"));
            string memory txParams = string.concat(
                "[{\"from\":\"",
                safeStr,
                "\",\"to\":\"",
                vm.toString(to),
                "\",\"data\":\"",
                vm.toString(data),
                "\",\"value\":\"0x0\",\"gas\":\"0x4c4b40\"}]"
            );
            vm.rpc("eth_sendTransaction", txParams);
        }

        vm.rpc("anvil_mine", "[]");
        vm.rpc("evm_setAutomine", "[true]");
        vm.rpc("anvil_stopImpersonatingAccount", string.concat("[\"", safeStr, "\"]"));

        // 5. Re-pin forge to the post-apply tip.
        vm.rollFork(startBlock + 1);

        emit log_named_uint("zac plan executed calls", callsCount);
        emit log_named_uint("rolled forge fork to", startBlock + 1);
    }

    /// @dev Strip the literal ".zac.yaml" suffix from a path.
    function _stripZacSuffix(string memory path) internal pure returns (string memory) {
        bytes memory b = bytes(path);
        bytes memory suffix = bytes(".zac.yaml");
        require(b.length >= suffix.length, "CsForkTest: path missing .zac.yaml suffix");
        uint256 cut = b.length - suffix.length;
        for (uint256 i = 0; i < suffix.length; i++) {
            require(b[cut + i] == suffix[i], "CsForkTest: path does not end with .zac.yaml");
        }
        bytes memory out = new bytes(cut);
        for (uint256 i = 0; i < cut; i++) out[i] = b[i];
        return string(out);
    }
}
