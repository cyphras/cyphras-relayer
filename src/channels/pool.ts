import { Keypair, Operation, TransactionBuilder, Asset, BASE_FEE, xdr } from "@stellar/stellar-sdk";
import { horizon, relayerKeypair } from "../stellar/rpc.js";
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

  // Provisions any missing channel and tops up any that fell below the threshold. Idempotent, so it
  // is safe to run on every boot.
  async ensureFunded(): Promise<void> {
    for (const channel of this.channels) {
      const balance = await nativeBalanceStroops(channel.publicKey());
      if (balance === null) {
        await createChannel(channel);
        logger.info({ channel: channel.publicKey() }, "channel created");
      } else if (balance < BigInt(config.CHANNEL_MIN_BALANCE_STROOPS)) {
        await topUpChannel(channel, balance);
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

async function nativeBalanceStroops(pubkey: string): Promise<bigint | null> {
  try {
    const account = await horizon.loadAccount(pubkey);
    const native = account.balances.find((b) => b.asset_type === "native");
    // Stellar balances are always formatted with 7 decimals, so dropping the dot yields stroops.
    return native ? BigInt(native.balance.replace(".", "")) : 0n;
  } catch (err) {
    if (isNotFound(err)) {
      return null;
    }
    throw err;
  }
}

// Channel funding is a classic-only transaction, submitted through Horizon rather than the Soroban
// RPC, which is the path for non-contract operations.
async function createChannel(channel: Keypair): Promise<void> {
  await submitFromMaster(
    Operation.createAccount({
      destination: channel.publicKey(),
      startingBalance: stroopsToXlm(BigInt(config.CHANNEL_FUND_STROOPS)),
    }),
  );
}

async function topUpChannel(channel: Keypair, current: bigint): Promise<void> {
  const amount = BigInt(config.CHANNEL_FUND_STROOPS) - current;
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
