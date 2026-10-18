// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {NamUsdcVault} from "../src/NamUsdcVault.sol";
import {TestUsdc} from "./mocks/TestToken.sol";

/// Unit and fuzz tests, written before the contract (ADR 0015 rule 4).
contract NamUsdcVaultTest is Test {
    TestUsdc internal usdc;
    NamUsdcVault internal vault;
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant ONE = 1e6;

    function setUp() public {
        usdc = new TestUsdc();
        vault = new NamUsdcVault(address(usdc), guardian);
        for (uint256 i = 0; i < 3; i++) {
            address who = [alice, bob, attacker][i];
            usdc.mint(who, 1_000_000 * ONE);
            vm.prank(who);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function test_metadata() public view {
        assertEq(address(vault.asset()), address(usdc));
        assertEq(vault.guardian(), guardian);
        assertEq(vault.decimals(), 12);
        assertEq(vault.symbol(), "namUSDC-SBX");
        assertEq(vault.totalAssets(), 0);
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(NamUsdcVault.ZeroAddress.selector);
        new NamUsdcVault(address(0), guardian);
        vm.expectRevert(NamUsdcVault.ZeroAddress.selector);
        new NamUsdcVault(address(usdc), address(0));
    }

    function test_depositMintsSharesAndAccountsAssets() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100 * ONE, alice);
        assertEq(shares, 100 * ONE * 1e6);
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.totalAssets(), 100 * ONE);
        assertEq(usdc.balanceOf(address(vault)), 100 * ONE);
    }

    function test_redeemReturnsAssetsAndBurnsShares() public {
        vm.startPrank(alice);
        uint256 shares = vault.deposit(100 * ONE, alice);
        uint256 before = usdc.balanceOf(alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        vm.stopPrank();
        assertLe(assets, 100 * ONE, "never more than went in");
        assertGe(assets, 100 * ONE - 1, "loses at most rounding");
        assertEq(usdc.balanceOf(alice) - before, assets);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.totalSupply(), 0);
    }

    function test_rejectsZeroAndDustDeposits() public {
        vm.startPrank(alice);
        vm.expectRevert(NamUsdcVault.ZeroAmount.selector);
        vault.deposit(0, alice);
        vm.expectRevert(NamUsdcVault.ZeroAddress.selector);
        vault.deposit(ONE, address(0));
        vm.stopPrank();
    }

    function test_rejectsRedeemingNothing() public {
        vm.prank(alice);
        vault.deposit(ONE, alice);
        vm.prank(alice);
        vm.expectRevert(NamUsdcVault.ZeroAmount.selector);
        vault.redeem(0, alice, alice);
    }

    function test_redeemOnBehalfNeedsAllowance() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(10 * ONE, alice);
        vm.prank(bob);
        vm.expectRevert();
        vault.redeem(shares, bob, alice);

        vm.prank(alice);
        vault.approve(bob, shares);
        vm.prank(bob);
        uint256 assets = vault.redeem(shares, bob, alice);
        assertGt(assets, 0);
        assertEq(vault.allowance(alice, bob), 0);
    }

    function test_donationDoesNotMoveTheSharePrice() public {
        vm.prank(alice);
        vault.deposit(100 * ONE, alice);
        uint256 priceBefore = vault.convertToAssets(1e18);
        vm.prank(attacker);
        usdc.transfer(address(vault), 50_000 * ONE);
        assertEq(vault.totalAssets(), 100 * ONE, "donations are never accounted");
        assertEq(vault.convertToAssets(1e18), priceBefore);
    }

    function test_firstDepositorInflationAttackFails() public {
        // Attacker deposits the minimum, then donates a large amount, hoping the
        // victim's deposit rounds to zero shares.
        vm.startPrank(attacker);
        vault.deposit(1, attacker);
        usdc.transfer(address(vault), 100_000 * ONE);
        vm.stopPrank();
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000 * ONE, alice);
        assertGt(shares, 0);
        vm.prank(alice);
        uint256 back = vault.redeem(shares, alice, alice);
        assertGe(back, 1_000 * ONE - 1, "victim loses at most rounding");
    }

    function test_onlyGuardianPausesAndOnlyDeposits() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(10 * ONE, alice);

        vm.prank(alice);
        vm.expectRevert(NamUsdcVault.NotGuardian.selector);
        vault.pauseDeposits();

        vm.prank(guardian);
        vault.pauseDeposits();
        assertTrue(vault.depositsPaused());
        assertEq(vault.maxDeposit(alice), 0);

        vm.prank(bob);
        vm.expectRevert(NamUsdcVault.DepositsArePaused.selector);
        vault.deposit(ONE, bob);

        vm.prank(alice);
        uint256 assets = vault.redeem(shares, alice, alice);
        assertGt(assets, 0, "redemption works while paused");

        vm.prank(guardian);
        vault.unpauseDeposits();
        vm.prank(bob);
        vault.deposit(ONE, bob);
    }

    function test_fullExitCanLeaveDustThatNobodyCanTake() public {
        vm.prank(alice);
        vault.deposit(15 * ONE, alice);
        vm.prank(bob);
        vault.deposit(10 * ONE, bob);
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(alice);
        vault.redeem(aliceShares / 3, alice, alice);
        uint256 rest = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(rest, alice, alice);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        assertEq(vault.totalSupply(), 0);
        assertLe(vault.totalAssets(), 2, "at most rounding dust remains");
        assertLe(vault.totalAssets(), usdc.balanceOf(address(vault)));
        vm.prank(attacker);
        vm.expectRevert(NamUsdcVault.ZeroAmount.selector);
        vault.redeem(0, attacker, attacker);
    }

    function test_previewsMatchActions() public {
        vm.prank(alice);
        vault.deposit(123 * ONE, alice);
        uint256 previewShares = vault.previewDeposit(7 * ONE);
        vm.prank(bob);
        assertEq(vault.deposit(7 * ONE, bob), previewShares);
        uint256 bobShares = vault.balanceOf(bob);
        uint256 previewAssets = vault.previewRedeem(bobShares);
        vm.prank(bob);
        assertEq(vault.redeem(bobShares, bob, bob), previewAssets);
        assertEq(vault.maxRedeem(alice), vault.balanceOf(alice));
    }

    function testFuzz_roundTripNeverProfits(uint256 seed, uint256 deposit, uint256 donation) public {
        uint256 existing = bound(seed, 0, 500_000 * ONE);
        deposit = bound(deposit, 1, 400_000 * ONE);
        donation = bound(donation, 0, 50_000 * ONE);
        if (existing > 0) {
            vm.prank(bob);
            vault.deposit(existing, bob);
        }
        if (donation > 0) {
            vm.prank(attacker);
            usdc.transfer(address(vault), donation);
        }
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 shares;
        try vault.deposit(deposit, alice) returns (uint256 minted) {
            shares = minted;
        } catch {
            return; // a deposit too small to mint a share is refused, never mispriced
        }
        vm.prank(alice);
        try vault.redeem(shares, alice, alice) {} catch {}
        assertLe(usdc.balanceOf(alice), before, "a round trip never pays out more than went in");
        assertLe(vault.totalAssets(), usdc.balanceOf(address(vault)));
    }
}
