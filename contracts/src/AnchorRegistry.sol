// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title AnchorRegistry
/// @notice TESTNET DEMONSTRATION ONLY — no independent review; Base Sepolia only
/// (ADR 0015). Specification: contracts/spec/AnchorRegistry.md.
/// @dev One append-only commitment per ledger period: a Merkle root of salted
/// journal-entry digests, a period identifier and a count. No personal data is
/// ever stored (CLAUDE.md rule 8). Holds no funds. Non-upgradeable.
contract AnchorRegistry is Ownable2Step {
    struct Anchor {
        bytes32 root;
        uint64 entryCount;
        uint64 anchoredAt;
    }

    address public anchorer;
    mapping(bytes32 periodId => Anchor) private anchors;

    event Anchored(bytes32 indexed periodId, bytes32 root, uint64 entryCount);
    event AnchorerChanged(address indexed previous, address indexed current);

    error NotAnchorer();
    error AlreadyAnchored(bytes32 periodId);
    error ZeroRoot();
    error ZeroAddress();
    error RenounceDisabled();

    constructor(address admin, address anchorer_) Ownable(admin) {
        if (anchorer_ == address(0)) revert ZeroAddress();
        anchorer = anchorer_;
        emit AnchorerChanged(address(0), anchorer_);
    }

    function anchor(bytes32 periodId, bytes32 root, uint64 entryCount) external {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (root == bytes32(0)) revert ZeroRoot();
        // slither-disable-next-line timestamp (compares the stored root, not a time)
        if (anchors[periodId].root != bytes32(0)) revert AlreadyAnchored(periodId);
        // casting to uint64 is safe: block timestamps fit in 64 bits for billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        anchors[periodId] = Anchor({root: root, entryCount: entryCount, anchoredAt: uint64(block.timestamp)});
        emit Anchored(periodId, root, entryCount);
    }

    function anchorOf(bytes32 periodId) external view returns (Anchor memory) {
        return anchors[periodId];
    }

    function setAnchorer(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit AnchorerChanged(anchorer, next);
        // The event above records the change (the linter does not see it before the write).
        // forge-lint: disable-next-line(missing-events-access-control)
        anchorer = next;
    }

    /// @dev Disabled: without an owner the anchorer could never be rotated.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
