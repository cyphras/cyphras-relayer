import { Keypair, Operation, TransactionBuilder, Asset, BASE_FEE, xdr } from "@stellar/stellar-sdk";
import { horizon, relayerKeypairs } from "../stellar/rpc.js";
import { withMasterSequence } from "../stellar/master.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { deriveChannels } from "./derive.js";

// A channel sources the create-ephemeral transaction for one in-flight reveal and is tied to the
// master that funds it. Each channel has its own sequence, so reveals run in parallel; the master
// only fee-bumps and tops up, neither of which consumes its sequence on the hot path.
export interface Channel {
  keypair: Keypair;
  master: Keypair;
}

interface MasterPool {
  master: Keypair;
  channels: Channel[];
  free: Channel[];
  waiters: Array<(channel: Channel) => void>;
}

// One channel pool per master. A reveal is routed to the master whose key the client bound into the
// proof as the fee recipient, so channels are acquired by master rather than from a single set.
export class ChannelPool {
  private readonly pools = new Map<string, MasterPool>();

  constructor() {
    for (const master of relayerKeypairs) {
      const channels = deriveChannels(master, config.CHANNEL_COUNT).map((keypair) => ({
        keypair,
        master,
      }));
      this.pools.set(master.publicKey(), { master, channels, free: [...channels], waiters: [] });
    }
  }

  async ensureFunded(): Promise<void> {
    let total = 0;
    for (const mp of this.pools.values()) {
      for (const channel of mp.channels) {
        const state = await channelState(channel.keypair.publicKey());
        if (!state.exists) {
          await createChannel(channel);
          logger.info({ channel: channel.keypair.publicKey() }, "channel created");
        } else if (state.spendable < BigInt(config.CHANNEL_MIN_BALANCE_STROOPS)) {
          await topUpChannel(channel, state.spendable);
          logger.info({ channel: channel.keypair.publicKey() }, "channel topped up");
        }
        total += 1;
      }
    }
    logger.info({ count: total, masters: this.pools.size }, "channels ready");
  }

  acquire(masterPublicKey: string): Promise<Channel> {
    const mp = this.pools.get(masterPublicKey);
    if (!mp) {
      return Promise.reject(new Error(`unknown relayer master ${masterPublicKey}`));
    }
    const channel = mp.free.pop();
    if (channel) {
      return Promise.resolve(channel);
    }
    return new Promise((resolve) => mp.waiters.push(resolve));
  }

  release(channel: Channel): void {
    const mp = this.pools.get(channel.master.publicKey());
    if (!mp) {
      return;
    }
    const waiter = mp.waiters.shift();
    if (waiter) {
      waiter(channel);
    } else {
      mp.free.push(channel);
    }
  }

  // The sweep needs the funding master to fee-bump an orphaned ephemeral's merge with the right wallet.
  masterForChannel(channelPublicKey: string): Keypair | undefined {
    for (const mp of this.pools.values()) {
      const match = mp.channels.find((c) => c.keypair.publicKey() === channelPublicKey);
      if (match) {
        return match.master;
      }
    }
    return undefined;
  }

  // The fee endpoint advertises this so clients route to the least-busy wallet.
  freeCounts(): Array<{ publicKey: string; freeChannels: number }> {
    return [...this.pools.values()].map((mp) => ({
      publicKey: mp.master.publicKey(),
      freeChannels: mp.free.length,
    }));
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
async function createChannel(channel: Channel): Promise<void> {
  const starting = BigInt(config.CHANNEL_FUND_STROOPS) + 2n * BASE_RESERVE_STROOPS;
  await submitFromMaster(
    channel.master,
    Operation.createAccount({
      destination: channel.keypair.publicKey(),
      startingBalance: stroopsToXlm(starting),
    }),
  );
}

async function topUpChannel(channel: Channel, spendable: bigint): Promise<void> {
  const amount = BigInt(config.CHANNEL_FUND_STROOPS) - spendable;
  if (amount <= 0n) {
    return;
  }
  await submitFromMaster(
    channel.master,
    Operation.payment({
      destination: channel.keypair.publicKey(),
      asset: Asset.native(),
      amount: stroopsToXlm(amount),
    }),
  );
}

async function submitFromMaster(master: Keypair, operation: xdr.Operation): Promise<void> {
  await withMasterSequence(master.publicKey(), async () => {
    const account = await horizon.loadAccount(master.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
    tx.sign(master);
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
