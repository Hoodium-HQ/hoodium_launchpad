// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * Stand-in for USDG — 6 decimals, standard semantics.
 *
 * 004 section 6 requires staging to run a mock USDG "matching mainnet USDG's
 * decimals and transfer semantics", and warns: if real USDG turns out to have
 * fee-on-transfer or blocklist behaviour, the mock must reproduce it or the tests
 * are worthless. That is T0.2, still open — see `FeeOnTransferUSDG` below, which
 * exists so the contracts' behaviour under that scenario is at least known.
 */
contract MockUSDG is ERC20 {
    constructor() ERC20("Global Dollar", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A USDG that skims 1% on transfer — the T0.2 scenario the curve must reject.
contract FeeOnTransferUSDG is ERC20 {
    constructor() ERC20("Fee USDG", "fUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
