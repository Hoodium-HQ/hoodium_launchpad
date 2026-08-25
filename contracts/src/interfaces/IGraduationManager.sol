// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IGraduationManager {
    /**
     * @notice Move a graduated curve's reserves into a Uniswap pool and lock the
     *         resulting position permanently.
     * @dev The caller must have approved `tokenAmount` of `token` and
     *      `usdgAmount` of USDG to this contract before calling.
     * @return pool The pool the liquidity landed in.
     * @return tokenId The locked position NFT.
     */
    function migrate(address token, uint256 tokenAmount, uint256 usdgAmount, address creator)
        external
        returns (address pool, uint256 tokenId);
}
