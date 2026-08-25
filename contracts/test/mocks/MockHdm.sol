// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice HDM as the factory sees it: an ordinary ERC20 that can be burned.
contract MockHdm is ERC20, ERC20Burnable {
    constructor() ERC20("Hoodium", "HDM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
