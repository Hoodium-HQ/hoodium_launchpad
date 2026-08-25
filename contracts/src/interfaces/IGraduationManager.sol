// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IGraduationManager {
    /**
     * @notice Move a graduated curve's reserves into a Uniswap pool and lock the
     *         resulting position permanently.
     * @dev Only a curve the manager's factory deployed for `token` may call this
     *      (`HoodiumFactory.curveOf(token) == msg.sender`). The caller must have
     *      approved `tokenAmount` of `token` and `usdgAmount` of USDG to this
     *      contract before calling.
     * @return pool The pool the liquidity landed in.
     * @return tokenId The locked position NFT.
     */
    function migrate(address token, uint256 tokenAmount, uint256 usdgAmount, address creator)
        external
        returns (address pool, uint256 tokenId);

    /// @notice The one factory whose curves may migrate through this manager.
    function factory() external view returns (address);
}

/// The one thing the manager needs to know about the factory: which curve, if
/// any, it deployed for a token. Kept as an interface so the manager does not
/// import the factory's bytecode.
interface IHoodiumFactory {
    function curveOf(address token) external view returns (address curve);
}
