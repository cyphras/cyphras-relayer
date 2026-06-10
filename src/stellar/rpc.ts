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

export const relayerKeypair = Keypair.fromSecret(config.RELAYER_SECRET);

export async function relayerXlmBalance(): Promise<string | null> {
  const account = await horizon.loadAccount(relayerKeypair.publicKey());
  return account.balances.find((b) => b.asset_type === "native")?.balance ?? null;
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
