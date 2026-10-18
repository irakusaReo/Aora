// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @notice TEST-ONLY ERC-20 for the local chain (anvil). Never deployed to any
/// network. Its runtime code is placed at an address with `anvil_setCode`, so it
/// has no constructor state: decimals are a constant and anyone may mint.
/// The API's local-chain tests place the 6-decimal variant at the configured
/// native USDC address (phase-5 plan P5-2) and the 18-decimal one elsewhere.
abstract contract TestTokenBase {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function decimals() public pure virtual returns (uint8);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Stands in for native USDC on the local chain: 6 decimals.
contract TestUsdc is TestTokenBase {
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @notice Any other token (stands in for USDbC, USDT and the like): 18 decimals.
contract TestOtherToken is TestTokenBase {
    function decimals() public pure override returns (uint8) {
        return 18;
    }
}
