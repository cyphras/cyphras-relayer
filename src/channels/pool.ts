import { Keypair, Operation, TransactionBuilder, Asset, BASE_FEE, xdr } from "@stellar/stellar-sdk";
import { horizon, relayerKeypair } from "../stellar/rpc.js";
import { withMasterSequence } from "../stellar/master.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { deriveChannels } from "./derive.js";

// Each channel is the source of the create-ephemeral transaction for one in-flight reveal. Because
// every channel has its own sequence number, reveals run in parallel instead of serializing on the
// master account. The master only fee-bumps and tops channels up, neither of which consumes its
// sequence on the hot path.
export class ChannelPool {
  private readonly channels: Keypair[];
  private readonly free: Keypair[];
  private readonly waiters: Array<(channel: Keypair) => void> = [];

  constructor() {
    this.channels = deriveChannels(relayerKeypair, config.CHANNEL_COUNT);
    this.free = [...this.channels];
  }

  // Provisions any missing channel and tops up any whose spendable balance fell below the threshold.
  // Idempotent, so it is safe to run on every boot.
  async ensureFunded(): Promise<void> {
    for (const channel of this.channels) {
      const state = await channelState(channel.publicKey());
      if (!state.exists) {
        await createChannel(channel);
        logger.info({ channel: channel.publicKey() }, "channel created");
      } else if (state.spendable < BigInt(config.CHANNEL_MIN_BALANCE_STROOPS)) {
        await topUpChannel(channel, state.spendable);
        logger.info({ channel: channel.publicKey() }, "channel topped up");
      }
    }
    logger.info({ count: this.channels.length }, "channels ready");
  }

  acquire(): Promise<Keypair> {
    const channel = this.free.pop();
    if (channel) {
      return Promise.resolve(channel);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(channel: Keypair): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(channel);
    } else {
      this.free.push(channel);
    }
  }
}

export const channelPool = new ChannelPool();

const BASE_RESERVE_STROOPS = 5000000n;

// The spendable balance is the native balance minus the account's minimum balance, which locks one
// base reserve per ledger entry: two for the account itself, plus one per subentry and per reserve
// the channel currently sponsors for an in-flight ephemeral. Funding against the raw balance would
// count reserve-locked XLM as available and leave the channel unable to sponsor.
async function channelState(pubkey: string): Promise<{ exists: boolean; spendable: bigint }> {
  try {
    const account = await horizon.loadAccount(pubkey);
    const native = account.balances.find((b) => b.asset_type === "native");
    // Stellar balances are always formatted with 7 decimals, so dropping the dot yields stroops.
    const balance = native ? BigInt(native.balance.replace(".", "")) : 0n;
    const sponsoring = BigInt(
      (account as unknown as { num_sponsoring?: number }).num_sponsoring ?? 0,
    );
    const entries = 2n + BigInt(account.subentry_count) + sponsoring;
    const reserved = entries * BASE_RESERVE_STROOPS;
    return { exists: true, spendable: balance > reserved ? balance - reserved : 0n };
  } catch (err) {
    if (isNotFound(err)) {
      return { exists: false, spendable: 0n };
    }
    throw err;
  }
}

// Channel funding is a classic-only transaction, submitted through Horizon rather than the Soroban
// RPC, which is the path for non-contract operations. A fresh account starts with the fund target
// plus the two base reserves it locks, so its spendable balance opens at the full target.
async function createChannel(channel: Keypair): Promise<void> {
  const starting = BigInt(config.CHANNEL_FUND_STROOPS) + 2n * BASE_RESERVE_STROOPS;
  await submitFromMaster(
    Operation.createAccount({
      destination: channel.publicKey(),
      startingBalance: stroopsToXlm(starting),
    }),
  );
}

async function topUpChannel(channel: Keypair, spendable: bigint): Promise<void> {
  const amount = BigInt(config.CHANNEL_FUND_STROOPS) - spendable;
  if (amount <= 0n) {
    return;
  }
  await submitFromMaster(
    Operation.payment({
      destination: channel.publicKey(),
      asset: Asset.native(),
      amount: stroopsToXlm(amount),
    }),
  );
}

async function submitFromMaster(operation: xdr.Operation): Promise<void> {
  await withMasterSequence(async () => {
    const master = await horizon.loadAccount(relayerKeypair.publicKey());
    const tx = new TransactionBuilder(master, {
      fee: BASE_FEE,
      networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
    tx.sign(relayerKeypair);
    await horizon.submitTransaction(tx);
  });
}

function stroopsToXlm(stroops: bigint): string {
  const s = stroops.toString().padStart(8, "0");
  return `${s.slice(0, -7)}.${s.slice(-7)}`;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { status?: number } }).response?.status === 404
  );
}
