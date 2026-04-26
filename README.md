# openclaw-cdp-wallet-skill

A minimal [Agent Skill](https://agentskills.io) that gives an autonomous AI agent a Coinbase CDP server wallet (v2) and four operations: `address`, `balance`, `send-usdc`, `history`. Base mainnet only. USDC only.

Works with [OpenClaw](https://github.com/openclaw/openclaw), [Hermes Agent](https://github.com/NousResearch/hermes-agent), [Claude Code](https://docs.claude.com/en/docs/claude-code), and any runtime that follows the agentskills.io standard.

## What this is for

If you want an OpenClaw or Hermes agent running on Railway / Fly / Hetzner / your laptop to be able to spend USDC autonomously — without you handing it a private key, and without an interactive OTP login on every container restart — this skill is the bridge. Wallet keys live in Coinbase's TEEs; the skill addresses the wallet by name (`getOrCreateAccount`), so the same env vars resolve to the same wallet across deploys.

## What it isn't

- Not a swap tool. Not a DeFi tool. Not a portfolio optimizer.
- Not self-custodial. The operator trusts Coinbase's TEE infrastructure with the keys.
- Not a Solana wallet. Base only.

The surface is intentionally small so it can be reviewed quickly and so failure modes are obvious.

## Install (OpenClaw)

```sh
git clone https://github.com/Ales375/openclaw-cdp-wallet-skill.git ~/.openclaw/skills/cdp-wallet
cd ~/.openclaw/skills/cdp-wallet
npm install
cp .env.example .env
# fill in your CDP credentials
```

For Hermes use `~/.hermes/skills/cdp-wallet`. For other runtimes, place under whatever skills directory they read.

## Configure

Three required env vars from [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com):

```
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
```

Two optional ones:

```
CDP_NETWORK=base                 # or base-sepolia
CDP_ACCOUNT_NAME=openclaw-default # rename to run multiple isolated wallets
```

## Use

```sh
node src/index.js address                      # 0x...
node src/index.js balance                      # ETH and USDC on Base
node src/index.js send-usdc 0xRecipient 1.50   # sends 1.50 USDC, waits for confirmation
node src/index.js history --limit 20           # last 20 USDC Transfer events
```

Every subcommand prints one line of JSON. `ok: true` on success, `ok: false` on failure. Designed to be agent-readable, not pretty-printed.

See [SKILL.md](SKILL.md) for the full agent-facing instructions, including expected failure modes and security notes.

## Why this exists

Most agent-wallet skills in the OpenClaw and Hermes ecosystems either (a) want a self-custodial private key on disk, (b) wrap Coinbase's *consumer* Agentic Wallet (which is great for connecting an agent to a human's existing Coinbase Wallet but doesn't programmatically create fresh isolated wallets), or (c) depend on third-party hosted services. None of those quite fit a scheduled, persistent, persona-driven autonomous agent that the operator wants to provision and forget about.

The CDP server wallet v2 path does fit that shape — programmatic creation, key custody by Coinbase's TEEs, idempotent named accounts, first-party SDK — but no minimal skill existed to expose it to OpenClaw / Hermes / agentskills.io agents until this one.

## License

MIT. See [LICENSE](LICENSE).

## Related

- [zooidfund-skill](https://github.com/Ales375/zooidfund-skill) — uses this skill as the recommended payment layer for OpenClaw agents donating to humanitarian campaigns on [zooidfund](https://zooid.fund).
- [@coinbase/cdp-sdk](https://github.com/coinbase/cdp-sdk) — the underlying SDK this skill wraps.
- [agentskills.io](https://agentskills.io) — the open standard this skill follows.
