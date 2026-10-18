# AORA contracts

> **Testnet demonstration only.** These contracts have had no independent review. They are deployed to Base Sepolia (84532) only and must never hold real funds. Base mainnet is forbidden (ADR 0015, CLAUDE.md rules 1 and 10).

| Contract                 | Specification                                    | Purpose                                                                           |
| ------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `src/NamUsdcVault.sol`   | [spec/NamUsdcVault.md](spec/NamUsdcVault.md)     | Single-asset vault over native USDC with internal asset accounting (NAM, Phase 6) |
| `src/AnchorRegistry.sol` | [spec/AnchorRegistry.md](spec/AnchorRegistry.md) | Append-only Merkle-root commitments per ledger period (Phase 5C)                  |

## Toolchain (pinned)

- Foundry v1.8.4 (`foundryup --install v1.8.4`, getfoundry.sh); Solidity 0.8.37; EVM `cancun`.
- forge-std v1.17.0 and OpenZeppelin Contracts v5.7.0 as git submodules under `lib/` (`git submodule update --init --recursive`).
- Slither 0.11.6 in CI (`--fail-low`).

## Commands

```bash
cd contracts && forge test            # unit, fuzz and invariant tests
cd contracts && forge fmt --check src script test
node contracts/scripts/export-abis.mjs         # after forge build: ABIs for the API
node contracts/scripts/export-test-tokens.mjs  # after forge build: TEST-ONLY token code for the API's local-chain tests
```

## Deployment

`node contracts/scripts/deploy.mjs` deploys both contracts with the sandbox signer key from `.env.local`, takes the native USDC address from the API's verified chain config, refuses any chain but 84532 and any existing record, verifies the source on Sourcify, and writes `deployments/base-sepolia.json`. The sandbox wallet holds every role: vault guardian, registry owner and anchorer. Rehearse on a local chain with `--rpc http://127.0.0.1:8545 --key-env <VAR> --out <file> --no-verify`.

`test/mocks/TestToken.sol` is TEST-ONLY: it is never deployed to any network.
