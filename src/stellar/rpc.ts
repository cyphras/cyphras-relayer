import { rpc, Horizon, Keypair } from "@stellar/stellar-sdk";
import { config } from "../config/index.js";

export const server = new rpc.Server(config.STELLAR_RPC_URL);

export const horizon = new Horizon.Server(config.STELLAR_HORIZON_URL);

export const relayerKeypair = Keypair.fromSecret(config.RELAYER_SECRET);

export async function relayerXlmBalance(): Promise<string | null> {
  const account = await horizon.loadAccount(relayerKeypair.publicKey());
  return account.balances.find((b) => b.asset_type === "native")?.balance ?? null;
}
