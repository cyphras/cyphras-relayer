import {
  rpc,
  Horizon,
  Keypair,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True for a shared-RPC rate-limit response (HTTP 429, including Cloudflare's "error 1015"), which is
// transient and worth retrying rather than surfacing as a hard failure.
function isRateLimited(err: unknown): boolean {
  const e = err as { response?: { status?: number }; status?: number; message?: string };
  if (e?.response?.status === 429 || e?.status === 429) {
    return true;
  }
  return /\b429\b|too many requests|rate limit|error 1015/i.test(String(e?.message ?? ""));
}

// Spaces RPC request starts by RPC_MIN_INTERVAL_MS so a burst of indexer/keeper reads does not trip a
// shared public RPC's rate limit. Left at 0 (a dedicated RPC), calls are not throttled.
let rpcGate: Promise<unknown> = Promise.resolve();
function throttleRpc(): Promise<void> {
  if (config.RPC_MIN_INTERVAL_MS <= 0) {
    return Promise.resolve();
  }
  const next = rpcGate.then(() => sleep(config.RPC_MIN_INTERVAL_MS));
  rpcGate = next.catch(() => undefined);
  return next;
}

// Retries a single RPC call on rate-limit responses with exponential backoff and jitter. Every RPC
// method used here is an idempotent read (submission goes through Horizon), so a retry is always safe.
async function withRpcResilience<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await throttleRpc();
    try {
      return await call();
    } catch (err) {
      if (!isRateLimited(err) || attempt >= config.RPC_MAX_RETRIES) {
        throw err;
      }
      const backoff =
        config.RPC_RETRY_BASE_MS * 2 ** attempt +
        Math.floor(Math.random() * config.RPC_RETRY_BASE_MS);
      logger.warn({ attempt: attempt + 1 }, "soroban rpc rate-limited, backing off");
      await sleep(backoff);
    }
  }
}

const rawServer = new rpc.Server(config.STELLAR_RPC_URL);

// One server backs every Soroban RPC call, so wrapping it makes rate-limit resilience apply everywhere:
// each method call is throttled and retried on a 429. Methods bind to the raw server, so the SDK's own
// internal calls bypass the wrapper and are not double-counted.
export const server: rpc.Server = new Proxy(rawServer, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== "function") {
      return value;
    }
    const method = value as (...a: unknown[]) => unknown;
    return (...args: unknown[]) =>
      withRpcResilience(() => method.apply(target, args) as Promise<unknown>);
  },
});

export const horizon = new Horizon.Server(config.STELLAR_HORIZON_URL);

// All master wallets. The first is the primary, used wherever a single master suffices (TTL keeper,
// contract reads, the default relayer when a client does not pick one). Each master funds its own
// channels and receives the fees of reveals bound to its public key.
export const relayerKeypairs: Keypair[] = [
  Keypair.fromSecret(config.RELAYER_SECRET),
  ...config.RELAYER_EXTRA_SECRETS.map((s) => Keypair.fromSecret(s)),
];

export const relayerKeypair = relayerKeypairs[0];

// Master keypair for a given public key, or undefined if it is not one of ours. Used to route a
// reveal to the wallet whose key the client bound into the proof as the fee recipient.
export function masterFor(publicKey: string): Keypair | undefined {
  return relayerKeypairs.find((k) => k.publicKey() === publicKey);
}

export async function xlmBalanceOf(publicKey: string): Promise<string | null> {
  const account = await horizon.loadAccount(publicKey);
  return account.balances.find((b) => b.asset_type === "native")?.balance ?? null;
}

export function relayerXlmBalance(): Promise<string | null> {
  return xlmBalanceOf(relayerKeypair.publicKey());
}

/**
 * Reads a contract function by simulating an invocation. The relayer account is only the
 * simulation source; nothing is submitted, so no fee is paid and no state changes.
 */
export async function readContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<unknown> {
  const account = await server.getAccount(relayerKeypair.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate ${method} failed: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error(`simulate ${method} returned no result`);
  }
  return scValToNative(sim.result.retval);
}

// Margin above the RPC's oldest ledger when used as a startLedger: that floor rises as ledgers prune,
// so requesting exactly at it (or at a stale cached value) races the edge and is rejected with -32600.
export const FLOOR_SAFETY_LEDGERS = 120;

// Discover the RPC's event-retention floor (it rises as ledgers prune) by probing an out-of-range
// startLedger and parsing the valid range from the error. Global, so cached briefly.
let oldestLedgerCache: { floor: number; at: number } | null = null;

export async function rpcOldestEventLedger(
  probeContract: string,
  latestLedger: number,
  fallbackWindow: number,
): Promise<number> {
  const now = Date.now();
  if (oldestLedgerCache && now - oldestLedgerCache.at < 60_000) {
    return oldestLedgerCache.floor;
  }
  let floor = Math.max(2, latestLedger - fallbackWindow);
  try {
    await server.getEvents({
      startLedger: 1,
      filters: [{ type: "contract", contractIds: [probeContract] }],
      limit: 1,
    });
    floor = 1;
  } catch (err) {
    const msg = String((err as { message?: string } | undefined)?.message ?? err);
    const m = msg.match(/range:\s*(\d+)\s*-\s*\d+/i);
    if (m) {
      floor = Number(m[1]);
    } else {
      logger.warn(
        { err, msg },
        "rpcOldestEventLedger: could not parse RPC range, using window estimate",
      );
    }
  }
  oldestLedgerCache = { floor, at: now };
  return floor;
}
