// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {LPLocker} from "../src/LPLocker.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

interface IPositionManagerFactory {
    function factory() external view returns (address);
}

/**
 * Deployment, in dependency order:
 *
 *   FeeVault → LPLocker → GraduationManager → HoodiumFactory
 *
 * Nothing here is upgradeable and nothing takes an admin (LP-N1), so this script
 * is the only chance to get the parameters right. Re-running it produces a new
 * generation; tokens launched from the old factory keep the old terms.
 *
 * Every value is read from the environment — there are no chain-specific
 * constants in this file. See `.env.example` for the full list and README.md
 * for the runbook. Required variables abort the run with a clear message when
 * missing; curve parameters have defaults matching design.md section 2 and
 * `DeployLocal.s.sol`, and are printed back before broadcasting so a mistyped
 * number can be caught while it is still free to fix.
 *
 *   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify ...
 */
contract Deploy is Script {
    struct Params {
        address usdg;
        uint8 usdgDecimals;
        address uniswapFactory;
        address positionManager;
        address[] vaultOwners;
        uint256 vaultThreshold;
        uint256 lpProtocolFeeShareBps;
        uint24 poolFee;
        int24 tickSpacing;
        uint256 totalSupply;
        uint256 curveAllocation;
        uint256 virtualUsdg;
        uint256 graduationTarget;
        uint256 graduationFee;
        uint256 tradeFeeBps;
        uint256 creatorFeeShareBps;
        uint256 creationFee;
        uint256 devBuyMaxBps;
        uint256 snipeBlocks;
        uint256 snipeMaxBps;
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        Params memory p = _load();
        _print(p);

        // Refuse to broadcast to a chain other than the one the operator said
        // they were targeting. A wrong RPC_URL with the right key is the most
        // likely way to deploy real, immutable contracts to the wrong network.
        uint256 expectedChain = vm.envOr("EXPECTED_CHAIN_ID", uint256(0));
        if (expectedChain != 0) {
            require(block.chainid == expectedChain, "chain id mismatch: check RPC_URL / EXPECTED_CHAIN_ID");
        }

        vm.startBroadcast(deployerKey);

        FeeVault vault = new FeeVault(p.vaultOwners, p.vaultThreshold);
        // LP-4.3 / T0.4 — the protocol's share of post-graduation pool fees. Stated
        // on the token page next to the claim button; immutable once deployed.
        LPLocker locker = new LPLocker(p.positionManager, address(vault), p.lpProtocolFeeShareBps);
        GraduationManager manager = new GraduationManager(
            p.uniswapFactory, p.positionManager, address(locker), p.usdg, p.poolFee, p.tickSpacing
        );

        HoodiumFactory factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: p.usdg,
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: p.totalSupply,
                curveAllocation: p.curveAllocation,
                virtualUsdg: p.virtualUsdg,
                graduationTarget: p.graduationTarget,
                graduationFee: p.graduationFee,
                tradeFeeBps: p.tradeFeeBps,
                creatorFeeShareBps: p.creatorFeeShareBps,
                creationFee: p.creationFee,
                devBuyMaxBps: p.devBuyMaxBps,
                snipeBlocks: p.snipeBlocks,
                snipeMaxBps: p.snipeMaxBps
            })
        );

        vm.stopBroadcast();

        console2.log("");
        console2.log("=== deployed (chain %s) ===", block.chainid);
        console2.log("FeeVault          ", address(vault));
        console2.log("LPLocker          ", address(locker));
        console2.log("GraduationManager ", address(manager));
        console2.log("HoodiumFactory    ", address(factory));
        console2.log("virtualTokens     ", factory.virtualTokens());
        console2.log("");
        console2.log("=== api env ===");
        console2.log("LAUNCHPAD_FACTORY_ADDRESS=%s", address(factory));
        console2.log("QUOTE_TOKEN_ADDRESS=%s", p.usdg);
        console2.log("QUOTE_TOKEN_DECIMALS=%s", uint256(p.usdgDecimals));
        console2.log("POSITION_MANAGER_ADDRESS=%s", p.positionManager);
        console2.log("UNISWAP_V3_FACTORY_ADDRESS=%s", p.uniswapFactory);
        console2.log("");
        console2.log("=== web env ===");
        console2.log("VITE_LAUNCHPAD_FACTORY=%s", address(factory));
        console2.log("VITE_QUOTE_ADDRESS=%s", p.usdg);
        console2.log("VITE_QUOTE_DECIMALS=%s", uint256(p.usdgDecimals));
        console2.log("VITE_POSITION_MANAGER=%s", p.positionManager);
    }

    function _load() internal view returns (Params memory p) {
        // ── Chain fixtures (required) ────────────────────────────────────────
        p.usdg = vm.envAddress("USDG_ADDRESS");
        p.positionManager = vm.envAddress("UNISWAP_POSITION_MANAGER");
        require(p.usdg.code.length > 0, "USDG_ADDRESS has no code on this chain");
        require(p.positionManager.code.length > 0, "UNISWAP_POSITION_MANAGER has no code on this chain");

        // The factory is derivable from the position manager; allow an override
        // but default to what the manager itself reports so the two cannot
        // disagree.
        p.uniswapFactory = vm.envOr("UNISWAP_V3_FACTORY", address(0));
        if (p.uniswapFactory == address(0)) {
            p.uniswapFactory = IPositionManagerFactory(p.positionManager).factory();
        }
        require(p.uniswapFactory.code.length > 0, "Uniswap factory has no code on this chain");

        // Decimals from the token itself unless overridden; a wrong unit here
        // scales every USDG-denominated parameter by 10^12.
        uint256 dec = vm.envOr("USDG_DECIMALS", uint256(0));
        if (dec == 0) dec = IERC20Decimals(p.usdg).decimals();
        require(dec > 0 && dec <= 18, "USDG_DECIMALS out of range");
        p.usdgDecimals = uint8(dec);
        uint256 usdgUnit = 10 ** dec;
        uint256 tokenUnit = 1e18;

        // ── Fee vault (required) ─────────────────────────────────────────────
        // LP-3.5 — the vault is a multisig, never an EOA. Supply at least two
        // signers; the constructor rejects a threshold of 1.
        p.vaultOwners = vm.envAddress("VAULT_OWNERS", ",");
        p.vaultThreshold = vm.envUint("VAULT_THRESHOLD");
        require(p.vaultOwners.length >= 2, "VAULT_OWNERS needs at least two signers");
        require(p.vaultThreshold >= 2 && p.vaultThreshold <= p.vaultOwners.length, "VAULT_THRESHOLD out of range");

        // ── Post-graduation pool (defaults: 1% tier) ─────────────────────────
        p.lpProtocolFeeShareBps = vm.envOr("LP_PROTOCOL_FEE_SHARE_BPS", uint256(3_000));
        p.poolFee = uint24(vm.envOr("POOL_FEE", uint256(10_000)));
        p.tickSpacing = int24(int256(vm.envOr("POOL_TICK_SPACING", uint256(200))));

        // ── Curve parameters (whole units; scaled here) ──────────────────────
        // design.md section 2 placeholders until T0.1 validates them.
        p.totalSupply = vm.envOr("TOTAL_SUPPLY", uint256(1_000_000_000)) * tokenUnit;
        p.curveAllocation = vm.envOr("CURVE_ALLOCATION", uint256(800_000_000)) * tokenUnit;
        p.virtualUsdg = vm.envOr("VIRTUAL_USDG", uint256(12_000)) * usdgUnit;
        p.graduationTarget = vm.envOr("GRADUATION_TARGET_USDG", uint256(69_000)) * usdgUnit;
        p.graduationFee = vm.envOr("GRADUATION_FEE_USDG", uint256(0)) * usdgUnit;
        p.creationFee = vm.envOr("CREATION_FEE_USDG", uint256(1)) * usdgUnit;

        // ── Fees and limits (basis points / blocks) ──────────────────────────
        p.tradeFeeBps = vm.envOr("TRADE_FEE_BPS", uint256(100)); // 1% (LP-2.3)
        p.creatorFeeShareBps = vm.envOr("CREATOR_FEE_SHARE_BPS", uint256(7_000)); // LP-3.1
        p.devBuyMaxBps = vm.envOr("DEV_BUY_MAX_BPS", uint256(500)); // LP-1.6
        p.snipeBlocks = vm.envOr("SNIPE_BLOCKS", uint256(3)); // LP-2.5
        p.snipeMaxBps = vm.envOr("SNIPE_MAX_BPS", uint256(100));

        require(p.curveAllocation <= p.totalSupply, "CURVE_ALLOCATION exceeds TOTAL_SUPPLY");
        require(p.graduationTarget > 0 && p.virtualUsdg > 0, "target and virtual USDG must be non-zero");
        require(p.tradeFeeBps <= 10_000 && p.creatorFeeShareBps <= 10_000, "bps out of range");
    }

    function _print(Params memory p) internal pure {
        console2.log("=== parameters ===");
        console2.log("USDG                    ", p.usdg);
        console2.log("USDG decimals           ", uint256(p.usdgDecimals));
        console2.log("Uniswap v3 factory      ", p.uniswapFactory);
        console2.log("Position manager        ", p.positionManager);
        for (uint256 i = 0; i < p.vaultOwners.length; i++) {
            console2.log("Vault owner             ", p.vaultOwners[i]);
        }
        console2.log("Vault threshold         ", p.vaultThreshold);
        console2.log("LP protocol share (bps) ", p.lpProtocolFeeShareBps);
        console2.log("Pool fee                ", uint256(p.poolFee));
        console2.log("Tick spacing            ", uint256(int256(p.tickSpacing)));
        console2.log("Total supply (wei)      ", p.totalSupply);
        console2.log("Curve allocation (wei)  ", p.curveAllocation);
        console2.log("Virtual USDG (units)    ", p.virtualUsdg);
        console2.log("Graduation target       ", p.graduationTarget);
        console2.log("Graduation fee          ", p.graduationFee);
        console2.log("Creation fee            ", p.creationFee);
        console2.log("Trade fee (bps)         ", p.tradeFeeBps);
        console2.log("Creator fee share (bps) ", p.creatorFeeShareBps);
        console2.log("Dev buy max (bps)       ", p.devBuyMaxBps);
        console2.log("Snipe blocks            ", p.snipeBlocks);
        console2.log("Snipe max (bps)         ", p.snipeMaxBps);
    }
}
