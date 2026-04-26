#!/usr/bin/env node
/**
 * cdp-wallet — minimal CLI wrapper around the CDP server wallet v2 SDK.
 *
 * Subcommands:
 *   address                       Print the wallet's EVM address.
 *   balance                       Print ETH and USDC balances on Base mainnet.
 *   send-usdc <to> <amount>       Send USDC on Base mainnet to <to>. Returns the tx hash.
 *   history [--limit N]           Print the last N USDC Transfer events involving this wallet.
 *
 * Output is JSON on a single line for machine consumption. Errors print
 * `{"ok":false,"error":"..."}` to stdout and exit with status 1.
 *
 * Required env: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET.
 * Optional env: CDP_ACCOUNT_NAME (default "openclaw-default"),
 *               CDP_NETWORK     (default "base"; use "base-sepolia" for testing),
 *               BASE_RPC_URL    (override the default public Base RPC).
 */

import "dotenv/config";
import { Command } from "commander";
import { CdpClient } from "@coinbase/cdp-sdk";
import {
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  formatEther,
  isAddress,
  getAddress,
} from "viem";
import { base, baseSepolia } from "viem/chains";

// --- Configuration --------------------------------------------------------

const NETWORK = (process.env.CDP_NETWORK || "base").trim();
const ACCOUNT_NAME = (process.env.CDP_ACCOUNT_NAME || "openclaw-default").trim();

const NETWORK_INFO = {
  base: {
    chain: base,
    explorer: "https://basescan.org/tx/",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    defaultRpc: "https://mainnet.base.org",
  },
  "base-sepolia": {
    chain: baseSepolia,
    explorer: "https://sepolia.basescan.org/tx/",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    defaultRpc: "https://sepolia.base.org",
  },
};

const network = NETWORK_INFO[NETWORK];
if (!network) {
  exitError(
    `Unsupported CDP_NETWORK: ${NETWORK}. Use "base" or "base-sepolia".`,
  );
}

// --- Utilities ------------------------------------------------------------

function exitOk(payload) {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
  process.exit(0);
}

function exitError(message, extra = {}) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: message, ...extra }) + "\n",
  );
  process.exit(1);
}

function requireEnv() {
  const missing = [
    "CDP_API_KEY_ID",
    "CDP_API_KEY_SECRET",
    "CDP_WALLET_SECRET",
  ].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    exitError(
      `Missing required env: ${missing.join(", ")}. See .env.example.`,
    );
  }
}

function publicClient() {
  const rpcUrl = process.env.BASE_RPC_URL || network.defaultRpc;
  return createPublicClient({ chain: network.chain, transport: http(rpcUrl) });
}

async function loadAccount() {
  // CdpClient reads CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET
  // from process.env automatically.
  const cdp = new CdpClient();
  // getOrCreateAccount is idempotent: same name → same address across runs.
  // This is what makes the wallet persistent on Railway despite ephemeral
  // filesystems — the wallet is held in CDP's TEE infrastructure, not on disk.
  const account = await cdp.evm.getOrCreateAccount({ name: ACCOUNT_NAME });
  return { cdp, account };
}

// Minimal ERC-20 ABI — only the bits this CLI needs.
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "account" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { type: "address", indexed: true, name: "from" },
      { type: "address", indexed: true, name: "to" },
      { type: "uint256", indexed: false, name: "value" },
    ],
  },
];

// --- Subcommand handlers --------------------------------------------------

async function cmdAddress() {
  requireEnv();
  const { account } = await loadAccount();
  exitOk({
    address: account.address,
    network: NETWORK,
    account_name: ACCOUNT_NAME,
  });
}

async function cmdBalance() {
  requireEnv();
  const { account } = await loadAccount();
  const client = publicClient();

  // Read native ETH balance and USDC balance in parallel.
  const [ethWei, usdcRaw] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({
      address: network.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address],
    }),
  ]);

  exitOk({
    address: account.address,
    network: NETWORK,
    eth: formatEther(ethWei),
    usdc: formatUnits(usdcRaw, 6),
    raw: {
      eth_wei: ethWei.toString(),
      usdc_atoms: usdcRaw.toString(),
    },
  });
}

async function cmdSendUsdc(toRaw, amountRaw) {
  requireEnv();

  if (!toRaw || !amountRaw) {
    exitError("Usage: cdp-wallet send-usdc <to_address> <amount_usdc>");
  }
  if (!isAddress(toRaw)) {
    exitError(`Recipient address is not a valid Ethereum address: ${toRaw}`);
  }
  const to = getAddress(toRaw); // checksum normalization

  const amountStr = String(amountRaw).trim();
  if (!/^\d+(\.\d+)?$/.test(amountStr)) {
    exitError(`Amount must be a positive decimal number, got: ${amountRaw}`);
  }

  let amountAtoms;
  try {
    amountAtoms = parseUnits(amountStr, 6); // USDC = 6 decimals
  } catch (err) {
    exitError(`Could not parse amount: ${err.message}`);
  }
  if (amountAtoms <= 0n) {
    exitError("Amount must be greater than 0.");
  }

  const { account } = await loadAccount();

  let transactionHash;
  try {
    const result = await account.transfer({
      to,
      amount: amountAtoms,
      token: "usdc",
      network: NETWORK,
    });
    transactionHash = result.transactionHash;
  } catch (err) {
    exitError(`CDP transfer failed: ${err.message}`, { phase: "submit" });
  }

  // Wait for one confirmation so the caller can rely on the tx being mined
  // before reporting success. zooidfund's confirm_donation needs the tx
  // visible on-chain before it'll accept.
  try {
    const client = publicClient();
    const receipt = await client.waitForTransactionReceipt({
      hash: transactionHash,
      timeout: 60_000,
    });
    if (receipt.status !== "success") {
      exitError(`Transaction reverted on-chain.`, {
        tx_hash: transactionHash,
        explorer: network.explorer + transactionHash,
      });
    }
  } catch (err) {
    // Submission succeeded but confirmation timed out — still useful info.
    exitOk({
      tx_hash: transactionHash,
      status: "submitted_unconfirmed",
      explorer: network.explorer + transactionHash,
      warning: `Submitted but not confirmed within timeout: ${err.message}`,
      from: account.address,
      to,
      amount_usdc: amountStr,
      network: NETWORK,
    });
  }

  exitOk({
    tx_hash: transactionHash,
    status: "confirmed",
    explorer: network.explorer + transactionHash,
    from: account.address,
    to,
    amount_usdc: amountStr,
    network: NETWORK,
  });
}

async function cmdHistory(opts) {
  requireEnv();
  const limit = Math.max(1, Math.min(50, parseInt(opts.limit ?? "10", 10) || 10));
  const lookback = BigInt(opts.lookback ?? "20000"); // default ~24h on Base

  const { account } = await loadAccount();
  const client = publicClient();

  const head = await client.getBlockNumber();
  const fromBlock = head > lookback ? head - lookback : 0n;

  // Pull both directions: USDC sent FROM us and USDC sent TO us.
  const [outgoing, incoming] = await Promise.all([
    client.getContractEvents({
      address: network.usdc,
      abi: ERC20_ABI,
      eventName: "Transfer",
      args: { from: account.address },
      fromBlock,
      toBlock: head,
    }),
    client.getContractEvents({
      address: network.usdc,
      abi: ERC20_ABI,
      eventName: "Transfer",
      args: { to: account.address },
      fromBlock,
      toBlock: head,
    }),
  ]);

  const events = [...outgoing, ...incoming]
    .map((ev) => ({
      direction:
        ev.args.from?.toLowerCase() === account.address.toLowerCase()
          ? "out"
          : "in",
      from: ev.args.from,
      to: ev.args.to,
      amount_usdc: formatUnits(ev.args.value ?? 0n, 6),
      block_number: ev.blockNumber.toString(),
      tx_hash: ev.transactionHash,
      explorer: network.explorer + ev.transactionHash,
    }))
    // Sort newest first.
    .sort((a, b) => Number(BigInt(b.block_number) - BigInt(a.block_number)))
    .slice(0, limit);

  exitOk({
    address: account.address,
    network: NETWORK,
    from_block: fromBlock.toString(),
    to_block: head.toString(),
    count: events.length,
    transfers: events,
  });
}

// --- CLI wiring -----------------------------------------------------------

const program = new Command();
program
  .name("cdp-wallet")
  .description(
    "Minimal CDP server wallet v2 CLI for OpenClaw / Hermes / any agentskills.io runtime.",
  )
  .version("0.1.0");

program
  .command("address")
  .description("Print the wallet's EVM address")
  .action(cmdAddress);

program
  .command("balance")
  .description("Print ETH and USDC balances")
  .action(cmdBalance);

program
  .command("send-usdc <to> <amount>")
  .description("Send USDC on Base; returns the transaction hash")
  .action(cmdSendUsdc);

program
  .command("history")
  .description("Print recent USDC Transfer events involving this wallet")
  .option("-l, --limit <n>", "max events to return (1-50)", "10")
  .option(
    "--lookback <blocks>",
    "how many blocks back to scan (default 20000 ≈ 24h on Base)",
    "20000",
  )
  .action(cmdHistory);

program.parseAsync(process.argv).catch((err) => {
  exitError(`Unexpected error: ${err.message}`, { stack: err.stack });
});
