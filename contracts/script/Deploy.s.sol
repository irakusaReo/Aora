// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {AnchorRegistry} from "../src/AnchorRegistry.sol";
import {NamUsdcVault} from "../src/NamUsdcVault.sol";

/// @notice Deploys AORA's two contracts to Base Sepolia (ADR 0015 rule 6).
/// Refuses every chain but Base Sepolia (84532). Run through
/// `contracts/scripts/deploy.mjs`, which supplies the native USDC address from
/// the API's verified chain config and the sandbox signer key from .env.local,
/// and records the result in contracts/deployments/base-sepolia.json.
/// The sandbox wallet holds every role (ADR 0015 rule 7): vault guardian,
/// registry owner and anchorer.
contract Deploy is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;

    error WrongChain(uint256 chainId);
    error WrongAsset(address asset);

    function run() external returns (NamUsdcVault vault, AnchorRegistry registry) {
        if (block.chainid != BASE_SEPOLIA) revert WrongChain(block.chainid);
        address usdc = vm.envAddress("AORA_USDC_ADDRESS");
        uint8 expectedDecimals = uint8(vm.envUint("AORA_USDC_DECIMALS"));
        if (usdc.code.length == 0 || IERC20Metadata(usdc).decimals() != expectedDecimals) {
            revert WrongAsset(usdc);
        }
        uint256 key = vm.envUint("AORA_DEPLOYER_KEY");
        address wallet = vm.addr(key);

        vm.startBroadcast(key);
        vault = new NamUsdcVault(usdc, wallet);
        registry = new AnchorRegistry(wallet, wallet);
        vm.stopBroadcast();
    }
}
