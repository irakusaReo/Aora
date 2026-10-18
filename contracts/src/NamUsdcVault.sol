// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title NamUsdcVault
/// @notice TESTNET DEMONSTRATION ONLY — no independent review; Base Sepolia only;
/// never real funds (ADR 0015). Specification: contracts/spec/NamUsdcVault.md.
/// @dev Single-asset vault over native USDC. Assets are tracked in
/// `accountedAssets`, changed only by deposit and redeem, never read from the
/// token balance, so donations cannot move the share price. Virtual shares
/// (DECIMALS_OFFSET) defeat the first-depositor attack. Rounding favours the
/// vault. Non-upgradeable; no owner; the guardian may only pause deposits.
contract NamUsdcVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant DECIMALS_OFFSET = 6;
    uint256 private constant VIRTUAL_SHARES = 10 ** DECIMALS_OFFSET;
    uint256 private constant VIRTUAL_ASSETS = 1;

    IERC20 public immutable asset;
    address public immutable guardian;
    uint8 private immutable assetDecimals;

    uint256 public accountedAssets;
    bool public depositsPaused;

    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event DepositsPaused(address indexed guardian);
    event DepositsUnpaused(address indexed guardian);

    error ZeroAddress();
    error ZeroAmount();
    error DepositsArePaused();
    error NotGuardian();
    error UnexpectedTransferAmount();

    constructor(address asset_, address guardian_) ERC20("AORA NAM Vault Share (Sandbox)", "namUSDC-SBX") {
        if (asset_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        asset = IERC20(asset_);
        guardian = guardian_;
        assetDecimals = IERC20Metadata(asset_).decimals();
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    function decimals() public view override returns (uint8) {
        return assetDecimals + DECIMALS_OFFSET;
    }

    // ---------------------------------------------------------------------
    // ERC-4626-like views
    // ---------------------------------------------------------------------

    function totalAssets() public view returns (uint256) {
        return accountedAssets;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, totalSupply() + VIRTUAL_SHARES, accountedAssets + VIRTUAL_ASSETS);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, accountedAssets + VIRTUAL_ASSETS, totalSupply() + VIRTUAL_SHARES);
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    function maxDeposit(address) external view returns (uint256) {
        return depositsPaused ? 0 : type(uint256).max;
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf(owner);
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (depositsPaused) revert DepositsArePaused();
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        shares = convertToShares(assets);
        if (shares == 0) revert ZeroAmount();

        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), assets);
        if (asset.balanceOf(address(this)) - before != assets) revert UnexpectedTransferAmount();

        accountedAssets += assets;
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroAddress();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        assets = convertToAssets(shares);
        if (assets == 0) revert ZeroAmount();

        _burn(owner, shares);
        accountedAssets -= assets;
        asset.safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    // ---------------------------------------------------------------------
    // Emergency control: deposits only. Redemptions can never be paused.
    // ---------------------------------------------------------------------

    function pauseDeposits() external onlyGuardian {
        depositsPaused = true;
        emit DepositsPaused(msg.sender);
    }

    function unpauseDeposits() external onlyGuardian {
        depositsPaused = false;
        emit DepositsUnpaused(msg.sender);
    }
}
