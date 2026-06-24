// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {CsForkTest} from "./CsForkTest.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    // Valid Aave V3 Pool API but NOT scoped — used to assert the modifier
    // rejects on-chain-valid-but-unscoped calls (borrow is a real lender-
    // side function the role policy never grants).
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
}

interface IRolesModifier {
    function execTransactionWithRole(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32 roleKey,
        bool shouldRevert
    ) external returns (bool);
}

/// @dev Zodiac Roles V2 throws this on any scoping rejection: wrong param
///      value, parameter not in oneOf, function not in scope, etc. The
///      `status` enum (uint8) tells you which kind of rejection it was;
///      `info` carries the rejected calldata (e.g. the offending function
///      selector). Selector: 0xd0a9bf58.
error ConditionViolation(uint8 status, bytes32 info);

/// @dev CS Safe — AAVE_V3 policy fork test (mainnet).
///
///      Applies `config/mainnet/0x40FF…DE58/aave_v3.zac.yaml` to the real
///      cs_modifier on a mainnet fork, then asserts:
///        - cs_member_mainnet can supply / withdraw USDC and approve the pool
///        - any out-of-scope variant (wrong spender, wrong asset, wrong
///          onBehalf, unscoped function) is rejected by the modifier
contract CsAaveV3MainnetTest is CsForkTest {
    // Mainnet protocol addresses.
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    // Coinshares-ZAC infra (from `aliases/mainnet/{safes,modifiers}.yaml`
    // and `aliases/signers.yaml`).
    address constant SAFE = 0x40FF9A84a5Da941A060E2925DA228aab328DDe58;
    address constant MODIFIER = 0x6a2A4eb8695e501AFD6599020FAB970D6018012a;
    address constant MEMBER = 0x4ecb4C676E596A5B2b9084c5Aec8fce058CE71A6;
    address constant WRONG = 0x000000000000000000000000000000000000dEaD;

    // SDK encodeKey('AAVE_V3') = right-padded ASCII bytes32.
    bytes32 constant ROLE_KEY = 0x414156455f563300000000000000000000000000000000000000000000000000;

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        zacApply("../config/mainnet/0x40FF9A84a5Da941A060E2925DA228aab328DDe58/aave_v3.zac.yaml");
    }

    // ── approve ─────────────────────────────────────────────────────────────

    /// TF-1 (happy): USDC.approve(AAVE_POOL, _) — scoped spender.
    function test_TF1_Approve_USDC_to_Pool_ok() public {
        _exec(USDC, abi.encodeWithSelector(IERC20.approve.selector, AAVE_POOL, 1_000_000));
        assertEq(IERC20(USDC).allowance(SAFE, AAVE_POOL), 1_000_000);
    }

    /// TF-2 (fail): USDC.approve to a non-pool spender is rejected.
    function test_TF2_Approve_USDC_to_Wrong_reverts() public {
        _execReverts(USDC, abi.encodeWithSelector(IERC20.approve.selector, WRONG, 1_000_000));
    }

    // ── supply ──────────────────────────────────────────────────────────────

    /// TF-3 (happy): pool.supply(USDC, _, SAFE, _) — asset in scope,
    ///       onBehalf pinned to avatar. The modifier accepts the call; the
    ///       Aave Pool itself reverts with INVALID_AMOUNT for amount=0
    ///       (a contract-layer concern, not a modifier-scoping concern),
    ///       so we use the "modifier-accepts" helper.
    function test_TF3_Supply_USDC_to_avatar_ok() public {
        _execModifierAccepts(
            AAVE_POOL, abi.encodeWithSelector(IAavePool.supply.selector, USDC, uint256(0), SAFE, uint16(0))
        );
    }

    /// TF-4 (fail): pool.supply(WETH, _, SAFE, _) — asset not in oneOf.
    function test_TF4_Supply_WETH_reverts() public {
        _execReverts(
            AAVE_POOL, abi.encodeWithSelector(IAavePool.supply.selector, WETH, uint256(0), SAFE, uint16(0))
        );
    }

    /// TF-5 (fail): pool.supply(USDC, _, WRONG, _) — onBehalf != avatar.
    function test_TF5_Supply_USDC_wrongOnBehalf_reverts() public {
        _execReverts(
            AAVE_POOL, abi.encodeWithSelector(IAavePool.supply.selector, USDC, uint256(0), WRONG, uint16(0))
        );
    }

    // ── withdraw ────────────────────────────────────────────────────────────

    /// TF-6 (happy): pool.withdraw(USDC, _, SAFE) — `to` pinned to avatar.
    ///       Same as TF-3 — Aave reverts INVALID_AMOUNT for amount=0; we
    ///       only assert the modifier accepted the scope.
    function test_TF6_Withdraw_USDC_to_avatar_ok() public {
        _execModifierAccepts(
            AAVE_POOL, abi.encodeWithSelector(IAavePool.withdraw.selector, USDC, uint256(0), SAFE)
        );
    }

    /// TF-7 (fail): pool.withdraw(USDC, _, WRONG) — `to` != avatar.
    function test_TF7_Withdraw_USDC_to_nonAvatar_reverts() public {
        _execReverts(
            AAVE_POOL, abi.encodeWithSelector(IAavePool.withdraw.selector, USDC, uint256(0), WRONG)
        );
    }

    /// TF-8 (fail): pool.withdraw(WETH, _, SAFE) — asset out of scope.
    function test_TF8_Withdraw_WETH_reverts() public {
        _execReverts(
            AAVE_POOL, abi.encodeWithSelector(IAavePool.withdraw.selector, WETH, uint256(0), SAFE)
        );
    }

    // ── valid-but-not-scoped ────────────────────────────────────────────────

    /// TF-9 (fail): pool.borrow(...) is a real Aave V3 function but the
    ///       role only grants supply / withdraw. Modifier rejects.
    function test_TF9_Borrow_unscoped_reverts() public {
        _execReverts(
            AAVE_POOL,
            abi.encodeWithSelector(IAavePool.borrow.selector, USDC, uint256(0), uint256(2), uint16(0), SAFE)
        );
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _exec(address to, bytes memory data) internal {
        vm.prank(MEMBER);
        bool ok = IRolesModifier(MODIFIER).execTransactionWithRole(to, 0, data, 0, ROLE_KEY, true);
        assertTrue(ok, "execTransactionWithRole returned false");
    }

    /// @dev Assert the modifier ACCEPTS the call's scope, without requiring
    ///      the inner call to succeed on-chain. With `shouldRevert=false`,
    ///      the modifier:
    ///        - reverts (with its own scoping error) if the role config
    ///          rejects the call;
    ///        - returns `false` if the role allows it but the target
    ///          contract itself reverts (e.g. Aave's INVALID_AMOUNT for
    ///          amount=0).
    ///      So a no-revert here proves the modifier scoping is correct.
    function _execModifierAccepts(address to, bytes memory data) internal {
        vm.prank(MEMBER);
        IRolesModifier(MODIFIER).execTransactionWithRole(to, 0, data, 0, ROLE_KEY, false);
    }

    /// @dev Assert the modifier REJECTS the call at the scoping layer.
    ///      `expectPartialRevert` matches only the selector prefix of the
    ///      revert data, so the per-rejection `(status, info)` ABI tail
    ///      (which varies by failure kind) doesn't need pinning. Narrows
    ///      the expected revert to Roles V2's `ConditionViolation`, so a
    ///      downstream-contract revert (different selector) would fail.
    function _execReverts(address to, bytes memory data) internal {
        vm.prank(MEMBER);
        vm.expectPartialRevert(ConditionViolation.selector);
        IRolesModifier(MODIFIER).execTransactionWithRole(to, 0, data, 0, ROLE_KEY, true);
    }
}
