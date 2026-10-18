// Deploys NamUsdcVault and AnchorRegistry to Base Sepolia (ADR 0015 rule 6),
// verifies their source on Sourcify (phase-5 plan P5-8) and records the result
// in contracts/deployments/base-sepolia.json.
//
//   node contracts/scripts/deploy.mjs            # Base Sepolia, from .env.local
//   node contracts/scripts/deploy.mjs --rpc http://127.0.0.1:8545 --key-env TEST_KEY \
//        --out /tmp/x.json --no-verify            # rehearsal on a local chain
//
// The native USDC address and decimals come from the API's verified chain config
// (the one place they live, ADR 0005). The signer key is read from the
// environment and handed to forge only through the child process environment:
// it never appears on a command line, in output or in the deployment record.
// Refuses any chain but 84532, and refuses to overwrite an existing record.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const BASE_SEPOLIA = 84532;
const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '..');
const forge = existsSync(join(homedir(), '.foundry/bin/forge'))
  ? join(homedir(), '.foundry/bin/forge')
  : 'forge';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
if (existsSync(join(repo, '.env.local'))) process.loadEnvFile(join(repo, '.env.local'));

const rpc = option('--rpc', process.env.BASE_SEPOLIA_RPC_URL);
const keyEnv = option('--key-env', 'SANDBOX_SIGNER_PRIVATE_KEY');
const out = resolve(option('--out', join(root, 'deployments/base-sepolia.json')));
const verify = !args.includes('--no-verify');
const key = process.env[keyEnv];

function fail(message) {
  console.error(`deploy: ${message}`);
  process.exit(1);
}

if (!rpc) fail('no RPC URL (BASE_SEPOLIA_RPC_URL or --rpc).');
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) fail(`${keyEnv} is missing or malformed.`);
if (existsSync(out)) fail(`${out} exists; contracts are not redeployed over a record.`);

const config = readFileSync(join(repo, 'services/api/src/modules/chain/config.ts'), 'utf8');
const usdc = /address: '(0x[0-9a-fA-F]{40})'/.exec(config)?.[1];
const decimals = /decimals: (\d+),/.exec(config)?.[1];
if (!usdc || !decimals) fail('could not read the USDC address and decimals from the chain config.');

const rpcCall = async (method, params = []) => {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method} failed`);
  return body.result;
};
const chainId = Number(await rpcCall('eth_chainId'));
if (chainId !== BASE_SEPOLIA) fail(`the RPC is on chain ${chainId}, not Base Sepolia.`);

const env = {
  ...process.env,
  AORA_DEPLOYER_KEY: key,
  AORA_USDC_ADDRESS: usdc,
  AORA_USDC_DECIMALS: decimals,
};
try {
  execFileSync(
    forge,
    ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', rpc, '--broadcast', '--slow'],
    { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] },
  );
} catch {
  fail('forge script failed (see above). Nothing is recorded.');
}

const run = JSON.parse(
  readFileSync(join(root, `broadcast/Deploy.s.sol/${BASE_SEPOLIA}/run-latest.json`), 'utf8'),
);
const receipts = new Map(run.receipts.map((r) => [r.transactionHash, r]));
const contracts = {};
let deployer = null;
for (const tx of run.transactions.filter((t) => t.transactionType === 'CREATE')) {
  const receipt = receipts.get(tx.hash);
  if (!receipt || Number(receipt.status) !== 1) fail(`deployment of ${tx.contractName} failed.`);
  deployer = tx.transaction.from;
  contracts[tx.contractName] = {
    address: tx.contractAddress,
    transaction_hash: tx.hash,
    block_number: Number(receipt.blockNumber),
    constructor_arguments: tx.arguments,
  };
}
for (const name of ['NamUsdcVault', 'AnchorRegistry']) {
  if (!contracts[name]) fail(`${name} was not deployed.`);
}

const verification = {};
if (verify) {
  for (const [name, record] of Object.entries(contracts)) {
    const encoded = execFileSync(
      'cast',
      ['abi-encode', 'constructor(address,address)', ...record.constructor_arguments],
      { cwd: root, encoding: 'utf8', env: { PATH: `${dirname(forge)}:${process.env.PATH}` } },
    ).trim();
    try {
      execFileSync(
        forge,
        [
          'verify-contract',
          record.address,
          `src/${name}.sol:${name}`,
          '--verifier',
          'sourcify',
          '--chain',
          String(BASE_SEPOLIA),
          '--constructor-args',
          encoded,
          '--watch',
        ],
        { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
      );
      verification[name] = 'verified on Sourcify';
    } catch {
      verification[name] = 'verification failed; retry with forge verify-contract';
    }
  }
}

const record = {
  note: 'SANDBOX. Base Sepolia testnet only. Testnet demonstration contracts with no independent review (ADR 0015).',
  network: 'base-sepolia',
  chain_id: BASE_SEPOLIA,
  deployed_at: new Date().toISOString(),
  deployer,
  roles:
    'The deployer (AORA sandbox testnet wallet) is the vault guardian and the registry owner and anchorer.',
  usdc: {
    address: usdc,
    decimals: Number(decimals),
    source: 'services/api/src/modules/chain/config.ts',
  },
  compiler: { solc: '0.8.37', evm_version: 'cancun', optimizer_runs: 200, bytecode_hash: 'none' },
  contracts,
  verification: verify ? verification : 'skipped (--no-verify)',
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `deployed: NamUsdcVault ${contracts.NamUsdcVault.address}, AnchorRegistry ${contracts.AnchorRegistry.address}`,
);
