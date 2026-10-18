// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AnchorRegistry} from "../src/AnchorRegistry.sol";

/// Unit, fuzz and invariant tests, written before the contract (ADR 0015 rule 4).
contract AnchorRegistryTest is Test {
    AnchorRegistry internal registry;
    address internal admin = makeAddr("admin");
    address internal anchorer = makeAddr("anchorer");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant DAY = keccak256("ledger-day:2026-10-18");
    bytes32 internal constant ROOT = keccak256("root");

    function setUp() public {
        registry = new AnchorRegistry(admin, anchorer);
    }

    function test_anchorerAnchorsOnce() public {
        vm.prank(anchorer);
        vm.expectEmit(true, false, false, true);
        emit AnchorRegistry.Anchored(DAY, ROOT, 42);
        registry.anchor(DAY, ROOT, 42);
        AnchorRegistry.Anchor memory stored = registry.anchorOf(DAY);
        assertEq(stored.root, ROOT);
        assertEq(stored.entryCount, 42);
        assertEq(stored.anchoredAt, uint64(block.timestamp));

        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.AlreadyAnchored.selector, DAY));
        registry.anchor(DAY, keccak256("other"), 1);
        assertEq(registry.anchorOf(DAY).root, ROOT, "a commitment never changes");
    }

    function test_onlyAnchorerAnchors() public {
        vm.prank(stranger);
        vm.expectRevert(AnchorRegistry.NotAnchorer.selector);
        registry.anchor(DAY, ROOT, 1);
        vm.prank(admin);
        vm.expectRevert(AnchorRegistry.NotAnchorer.selector);
        registry.anchor(DAY, ROOT, 1);
    }

    function test_rejectsZeroRoot() public {
        vm.prank(anchorer);
        vm.expectRevert(AnchorRegistry.ZeroRoot.selector);
        registry.anchor(DAY, bytes32(0), 1);
    }

    function test_adminRotatesAnchorerAndOldOneStops() public {
        address next = makeAddr("next");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setAnchorer(next);

        vm.prank(admin);
        registry.setAnchorer(next);
        assertEq(registry.anchorer(), next);

        vm.prank(anchorer);
        vm.expectRevert(AnchorRegistry.NotAnchorer.selector);
        registry.anchor(DAY, ROOT, 1);
        vm.prank(next);
        registry.anchor(DAY, ROOT, 1);
    }

    function test_rejectsZeroAddresses() public {
        vm.prank(admin);
        vm.expectRevert(AnchorRegistry.ZeroAddress.selector);
        registry.setAnchorer(address(0));
        vm.expectRevert(AnchorRegistry.ZeroAddress.selector);
        new AnchorRegistry(admin, address(0));
    }

    function test_ownershipMovesInTwoStepsAndCannotBeRenounced() public {
        address next = makeAddr("nextAdmin");
        vm.prank(admin);
        registry.transferOwnership(next);
        assertEq(registry.owner(), admin);
        vm.prank(next);
        registry.acceptOwnership();
        assertEq(registry.owner(), next);

        vm.prank(next);
        vm.expectRevert(AnchorRegistry.RenounceDisabled.selector);
        registry.renounceOwnership();
        assertEq(registry.owner(), next);
    }

    function testFuzz_anyPeriodAnchorsExactlyOnce(bytes32 period, bytes32 root, uint64 count) public {
        vm.assume(root != bytes32(0));
        vm.prank(anchorer);
        registry.anchor(period, root, count);
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(AnchorRegistry.AlreadyAnchored.selector, period));
        registry.anchor(period, root, count);
        assertEq(registry.anchorOf(period).root, root);
    }
}

/// Random anchors, rotations and attempts by others; recorded roots never change.
contract RegistryHandler is Test {
    AnchorRegistry internal immutable registry;
    address internal immutable admin;
    address public currentAnchorer;
    bytes32[] public periods;
    mapping(bytes32 => bytes32) public firstRoot;
    bool public strangerSucceeded;

    constructor(AnchorRegistry registry_, address admin_, address anchorer_) {
        registry = registry_;
        admin = admin_;
        currentAnchorer = anchorer_;
    }

    function periodCount() external view returns (uint256) {
        return periods.length;
    }

    function anchor(uint8 period, bytes32 root, uint64 count) external {
        bytes32 id = keccak256(abi.encode(period));
        if (root == bytes32(0)) root = keccak256(abi.encode(root, period));
        vm.prank(currentAnchorer);
        try registry.anchor(id, root, count) {
            periods.push(id);
            firstRoot[id] = root;
        } catch {}
    }

    function strangerAnchors(uint8 period, bytes32 root, address who) external {
        if (who == currentAnchorer || root == bytes32(0)) return;
        vm.prank(who);
        try registry.anchor(keccak256(abi.encode(period, "stranger")), root, 1) {
            strangerSucceeded = true;
        } catch {}
    }

    function rotate(address next) external {
        if (next == address(0)) return;
        vm.prank(admin);
        registry.setAnchorer(next);
        currentAnchorer = next;
    }
}

contract AnchorRegistryInvariantTest is Test {
    AnchorRegistry internal registry;
    RegistryHandler internal handler;

    function setUp() public {
        address admin = makeAddr("admin");
        address anchorer = makeAddr("anchorer");
        registry = new AnchorRegistry(admin, anchorer);
        handler = new RegistryHandler(registry, admin, anchorer);
        targetContract(address(handler));
    }

    function invariant_recordedRootsNeverChange() public view {
        for (uint256 i = 0; i < handler.periodCount(); i++) {
            bytes32 id = handler.periods(i);
            assertEq(registry.anchorOf(id).root, handler.firstRoot(id));
        }
    }

    function invariant_onlyTheAnchorerAdds() public view {
        assertFalse(handler.strangerSucceeded());
    }
}
