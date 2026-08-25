// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @notice The one HDM function this repo calls.
 *
 * @dev Narrow on purpose, the same rule the rest of these interfaces follow:
 *      the factory can burn a creator's HDM and can do nothing else with it.
 *      `burnFrom` spends an allowance, so a creator who has not approved the
 *      factory simply cannot launch, and one who approved exactly one launch
 *      fee cannot be charged for two.
 */
interface IERC20Burnable {
    function burnFrom(address account, uint256 value) external;
}
