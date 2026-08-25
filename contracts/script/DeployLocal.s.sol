// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {GraduationHelper} from "../src/GraduationHelper.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {LPLocker} from "../src/LPLocker.sol";
import {MockUSDG} from "../test/mocks/MockUSDG.sol";
import {MockUniswapFactory, MockPositionManager} from "../test/mocks/MockUniswap.sol";

/**
 * Local-only deployment — the whole launchpad on a bare Anvil, from nothing.
 *
 * `Deploy.s.sol` assumes USDG and Uniswap already exist on the chain, which is
 * true of mainnet and false of a fresh `anvil`. This script deploys stand-ins for
 * both first, so a developer can go from an empty node to a working launch form
 * in one command:
 *
 *   anvil
 *   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 *
 * It refuses to run anywhere except chain 31337. The mocks below are test doubles
 * — MockPositionManager mints ERC-721s over a price-aware but tickless pool
 * model — so a graduation here proves the call path and the pricing rules, and
 * nothing about the real Uniswap deployment. On any real chain that is a lie
 * about where users' liquidity went, which is why the guard is a `require` and
 * not a comment.
 *
 * Parameters mirror `Deploy.s.sol` exactly — a local chain that behaves
 * differently from the deploy script it stands in for is worse than no local
 * chain.
 */
contract DeployLocal is Script {
    uint256 private constant ANVIL_CHAIN_ID = 31337;

    /// Anvil's first deterministic account. Public knowledge, worthless anywhere real.
    uint256 private constant ANVIL_KEY_0 = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        require(
            block.chainid == ANVIL_CHAIN_ID,
            "DeployLocal is for Anvil (31337) only - it deploys mock USDG and mock Uniswap. Use Deploy.s.sol."
        );

        uint256 deployerKey = vm.envOr("PRIVATE_KEY", ANVIL_KEY_0);
        address deployer = vm.addr(deployerKey);

        // Optional: an address to fund with mock USDG, so the wallet you connect
        // in the browser can actually buy on a curve. Defaults to the deployer,
        // which is not the account MetaMask is holding.
        d.seedWallet = vm.envOr("SEED_WALLET", deployer);

        uint256 usdgUnit = 1e6; // MockUSDG is 6 decimals, like mainnet USDG
        uint256 tokenUnit = 1e18;

        vm.startBroadcast(deployerKey);

        // ── Stand-ins for what mainnet already has ───────────────────────────
        MockUSDG usdg = new MockUSDG();
        MockUniswapFactory uniswapFactory = new MockUniswapFactory();
        MockPositionManager positionManager = new MockPositionManager(uniswapFactory);
        d.usdg = address(usdg);
        d.uniswapFactory = address(uniswapFactory);
        d.positionManager = address(positionManager);

        usdg.mint(deployer, 10_000_000 * usdgUnit);
        if (d.seedWallet != deployer) usdg.mint(d.seedWallet, 10_000_000 * usdgUnit);

        // ── The launchpad itself, in dependency order ────────────────────────
        // LP-3.5 — the vault is a multisig, never an EOA. Three signers, threshold
        // 2, same shape the constructor enforces on mainnet.
        address[] memory owners = new address[](3);
        owners[0] = deployer;
        owners[1] = vm.addr(uint256(keccak256("hoodium.local.signer.2")));
        owners[2] = vm.addr(uint256(keccak256("hoodium.local.signer.3")));

        FeeVault vault = new FeeVault(owners, 2);
        d.vault = address(vault);

        // Forward references, exactly as Deploy.s.sol does them: the locker
        // names the manager and the manager names the factory before either
        // exists. Nonce arithmetic from here: locker = n, manager = n+1,
        // factory = n+2.
        uint64 nonce = vm.getNonce(deployer);
        address predictedManager = vm.computeCreateAddress(deployer, nonce + 1);
        address predictedFactory = vm.computeCreateAddress(deployer, nonce + 2);

        // 30% of post-graduation pool fees to the protocol, 70% to the creator.
        // Mirrors Deploy.s.sol so local behaviour matches what would ship.
        LPLocker locker = new LPLocker(address(positionManager), address(vault), 3_000, predictedManager);
        GraduationManager manager = new GraduationManager(
            address(uniswapFactory),
            address(positionManager),
            address(locker),
            address(usdg),
            10_000, // 1% pool fee
            200, // tick spacing for the 1% tier
            predictedFactory
        );
        require(address(manager) == predictedManager, "manager address drifted");
        d.locker = address(locker);
        d.manager = address(manager);

        HoodiumFactory factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: 1_000_000_000 * tokenUnit,
                curveAllocation: 800_000_000 * tokenUnit, // virtual reserves derived: vU = 23,000 USDG
                graduationTarget: 69_000 * usdgUnit,
                graduationFee: 0, // LP-3.3 — the incumbent charges none
                tradeFeeBps: 100, // 1% (LP-2.3)
                creatorFeeShareBps: 7_000, // 70% of fees to the creator (LP-3.1)
                creationFee: 1 * usdgUnit, // LP-1.5, ~0.0005 ETH in USDG terms
                devBuyMaxBps: 500, // 5% of supply (LP-1.6)
                snipeBlocks: 3, // LP-2.5
                snipeMaxBps: 100 // 1% of supply per tx in the window
            })
        );

        require(address(factory) == predictedFactory, "factory address drifted");

        // Periphery, no pairing: deployed after the nonce-sensitive chain.
        GraduationHelper helper = new GraduationHelper();

        vm.stopBroadcast();

        d.factory = address(factory);
        d.helper = address(helper);
        _report();
        console2.log("Restart both dev servers after editing - neither reloads .env on its own.");
    }

    /// The report lives in its own frame: nine addresses plus the run()
    /// locals is past what legacy codegen can keep on the stack, and solc's
    /// answer ("stack too deep") shows up on some toolchains and not others.
    struct Deployed {
        address usdg;
        address uniswapFactory;
        address positionManager;
        address vault;
        address locker;
        address manager;
        address factory;
        address helper;
        address seedWallet;
    }

    Deployed private d;

    function _report() internal view {
        console2.log("");
        console2.log("=== deployed ===");
        console2.log("MockUSDG           ", d.usdg);
        console2.log("MockUniswapFactory ", d.uniswapFactory);
        console2.log("MockPositionManager", d.positionManager);
        console2.log("FeeVault           ", d.vault);
        console2.log("LPLocker           ", d.locker);
        console2.log("GraduationManager  ", d.manager);
        console2.log("HoodiumFactory     ", d.factory);
        console2.log("GraduationHelper   ", d.helper);
        console2.log("");
        console2.log("USDG funded        ", d.seedWallet);
        console2.log("");
        console2.log("=== hoodium_backend/.env ===");
        console2.log("LAUNCHPAD_FACTORY_ADDRESS=%s", d.factory);
        console2.log("QUOTE_TOKEN_ADDRESS=%s", d.usdg);
        console2.log("POSITION_MANAGER_ADDRESS=%s", d.positionManager);
        console2.log("UNISWAP_V3_FACTORY_ADDRESS=%s", d.uniswapFactory);
        console2.log("");
        console2.log("=== hoodium_frontend/.env ===");
        console2.log("VITE_LAUNCHPAD_FACTORY=%s", d.factory);
        console2.log("VITE_QUOTE_ADDRESS=%s", d.usdg);
        console2.log("VITE_GRADUATION_HELPER=%s", d.helper);
        console2.log("");
    }
}
