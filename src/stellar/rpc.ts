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

export const server = new rpc.Server(config.STELLAR_RPC_URL);

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
