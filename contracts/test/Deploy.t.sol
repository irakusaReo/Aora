// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {AnchorRegistry} from "../src/AnchorRegistry.sol";
import {NamUsdcVault} from "../src/NamUsdcVault.sol";
import {TestOtherToken, TestUsdc} from "./mocks/TestToken.sol";

/// The deployment script refuses every chain but Base Sepolia and any asset
/// other than a 6-decimal token at the given address (ADR 0015 rule 6).
contract DeployTest is Test {
    Deploy internal script;
    uint256 internal constant KEY = 0xA11CE;

    function setUp() public {
        script = new Deploy();
        vm.setEnv("AORA_DEPLOYER_KEY", vm.toString(KEY));
        vm.setEnv("AORA_USDC_DECIMALS", "6");
    }

    function test_refusesAnyChainButBaseSepolia() public {
        TestUsdc usdc = new TestUsdc();
        vm.setEnv("AORA_USDC_ADDRESS", vm.toString(address(usdc)));
        uint256[3] memory others = [uint256(1), 8453, 31337];
        for (uint256 i = 0; i < others.length; i++) {
            vm.chainId(others[i]);
            vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, others[i]));
            script.run();
        }
    }

    function test_refusesAnAssetWithOtherDecimalsOrNoCode() public {
        vm.chainId(84532);
        TestOtherToken other = new TestOtherToken();
        vm.setEnv("AORA_USDC_ADDRESS", vm.toString(address(other)));
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongAsset.selector, address(other)));
        script.run();

        address empty = makeAddr("empty");
        vm.setEnv("AORA_USDC_ADDRESS", vm.toString(empty));
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongAsset.selector, empty));
        script.run();
    }

    function test_deploysBothWithTheSandboxWalletInEveryRole() public {
        vm.chainId(84532);
        TestUsdc usdc = new TestUsdc();
        vm.setEnv("AORA_USDC_ADDRESS", vm.toString(address(usdc)));
        (address vault, address registry) = _run();
        address wallet = vm.addr(KEY);
        (bool ok, bytes memory guardian) = vault.staticcall(abi.encodeWithSignature("guardian()"));
        assertTrue(ok);
        assertEq(abi.decode(guardian, (address)), wallet);
        (, bytes memory asset) = vault.staticcall(abi.encodeWithSignature("asset()"));
        assertEq(abi.decode(asset, (address)), address(usdc));
        (, bytes memory owner) = registry.staticcall(abi.encodeWithSignature("owner()"));
        assertEq(abi.decode(owner, (address)), wallet);
        (, bytes memory anchorer) = registry.staticcall(abi.encodeWithSignature("anchorer()"));
        assertEq(abi.decode(anchorer, (address)), wallet);
    }

    function _run() internal returns (address, address) {
        (NamUsdcVault vault, AnchorRegistry registry) = script.run();
        return (address(vault), address(registry));
    }
}
