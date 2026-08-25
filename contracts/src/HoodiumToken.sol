// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title HoodiumToken
 * @notice T1.1 / LP-1.2 — "The deployed token SHALL have a fixed supply, no mint
 *         function, and no owner privileges after deployment."
 *
 * The entire supply is minted once, in the constructor, to the curve. After that
 * this contract has no privileged caller at all: there is no owner, no minter, no
 * pause, no blocklist, and no upgrade path (LP-N1).
 *
 * Read what is absent as carefully as what is present. Every one of those
 * features is a lever a creator could pull after buyers have money in the token,
 * which is why none of them exist.
 */
contract HoodiumToken is ERC20 {
    /// @notice Who deployed this token. Informational only — it grants nothing.
    address public immutable creator;

    /// @notice IPFS hash of the token metadata (LP-1.7).
    string public metadataURI;

    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 totalSupply_,
        address recipient,
        address creator_,
        string memory metadataURI_
    ) ERC20(name_, symbol_) {
        require(recipient != address(0), "recipient=0");
        require(totalSupply_ > 0, "supply=0");

        creator = creator_;
        metadataURI = metadataURI_;
        _decimals = decimals_;

        // The one and only mint. `_mint` is internal and nothing else calls it,
        // so total supply is fixed for the life of the contract.
        _mint(recipient, totalSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
