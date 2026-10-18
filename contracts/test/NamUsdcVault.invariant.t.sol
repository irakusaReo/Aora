// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {NamUsdcVault} from "../src/NamUsdcVault.sol";
import {TestUsdc} from "./mocks/TestToken.sol";

/// Drives the vault with random deposits, donations, redemptions and pauses.
contract VaultHandler is Test {
    NamUsdcVault internal immutable vault;
    TestUsdc internal immutable usdc;
    address internal immutable guardian;
    address[] internal actors;
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public redeemed;
    uint256 public totalDeposited;
    uint256 public totalRedeemed;
    /// Successful deposits and redemptions: each can leave at most one base unit of rounding dust.
    uint256 public operations;
    bool public redeemFailedWhilePaused;

    constructor(NamUsdcVault vault_, TestUsdc usdc_, address guardian_) {
        vault = vault_;
        usdc = usdc_;
        guardian = guardian_;
        for (uint256 i = 0; i < 4; i++) {
            address actor = address(uint160(0xA0000 + i));
            actors.push(actor);
            usdc.mint(actor, 10_000_000e6);
            vm.prank(actor);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function deposit(uint256 who, uint256 amount) external {
        address actor = actors[who % actors.length];
        amount = bound(amount, 1, 1_000_000e6);
        vm.prank(actor);
        try vault.deposit(amount, actor) {
            deposited[actor] += amount;
            totalDeposited += amount;
            operations += 1;
        } catch {}
    }

    function donate(uint256 who, uint256 amount) external {
        address actor = actors[who % actors.length];
        amount = bound(amount, 1, 100_000e6);
        vm.prank(actor);
        usdc.transfer(address(vault), amount);
    }

    function redeem(uint256 who, uint256 fraction) external {
        address actor = actors[who % actors.length];
        uint256 shares = vault.balanceOf(actor);
        if (shares == 0) return;
        shares = bound(fraction, 1, shares);
        if (vault.previewRedeem(shares) == 0) return;
        vm.prank(actor);
        try vault.redeem(shares, actor, actor) returns (uint256 assets) {
            redeemed[actor] += assets;
            totalRedeemed += assets;
            operations += 1;
        } catch {
            if (vault.depositsPaused()) redeemFailedWhilePaused = true;
        }
    }

    function togglePause(bool pause) external {
        vm.prank(guardian);
        if (pause && !vault.depositsPaused()) vault.pauseDeposits();
        if (!pause && vault.depositsPaused()) vault.unpauseDeposits();
    }
}

/// ADR 0015 vault invariants.
contract NamUsdcVaultInvariantTest is Test {
    NamUsdcVault internal vault;
    TestUsdc internal usdc;
    VaultHandler internal handler;

    function setUp() public {
        usdc = new TestUsdc();
        address guardian = makeAddr("guardian");
        vault = new NamUsdcVault(address(usdc), guardian);
        handler = new VaultHandler(vault, usdc, guardian);
        targetContract(address(handler));
    }

    function invariant_accountedAssetsNeverExceedBalance() public view {
        assertLe(vault.totalAssets(), usdc.balanceOf(address(vault)));
    }

    function invariant_allSharesRedeemForAtMostAccountedAssets() public view {
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets());
        if (vault.totalSupply() == 0) assertEq(vault.totalAssets(), 0);
    }

    /// The vault never pays out value nobody deposited: donations are not
    /// accounted, so all redemptions together never exceed all deposits, and
    /// accounting is exact.
    function invariant_vaultNeverPaysOutMoreThanWasDeposited() public view {
        assertLe(handler.totalRedeemed(), handler.totalDeposited());
        assertEq(vault.totalAssets(), handler.totalDeposited() - handler.totalRedeemed());
    }

    /// An account can gain only the rounding dust that other operations left in
    /// the vault (at most one base unit each), never a donation and never more.
    function invariant_noAccountGainsMoreThanRoundingDust() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address actor = handler.actorAt(i);
            assertLe(handler.redeemed(actor), handler.deposited(actor) + handler.operations());
        }
    }

    function invariant_redemptionAlwaysPossibleWhilePaused() public view {
        assertFalse(handler.redeemFailedWhilePaused());
    }
}
