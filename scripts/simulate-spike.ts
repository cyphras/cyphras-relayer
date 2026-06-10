import { rpc, Contract, TransactionBuilder, BASE_FEE, scValToNative } from "@stellar/stellar-sdk";
import { config } from "../src/config/index.js";
import { server, relayerKeypair } from "../src/stellar/rpc.js";

// Proves the relayer can reach the RPC, simulate a contract call, and read the resource fee.
// The fee estimator and the pre-submit economic guard build on this exact primitive: simulate a
// reveal, read minResourceFee, and reject the request if it would lose money.

const poolId = process.env.POOL_ID;
if (!poolId) {
  throw new Error("set POOL_ID to a deployed pool contract address");
}

const account = await server.getAccount(relayerKeypair.publicKey());
const contract = new Contract(poolId);
const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
})
  .addOperation(contract.call("get_denomination"))
  .setTimeout(30)
  .build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) {
  throw new Error(`simulation failed: ${sim.error}`);
}

console.log("simulation ok");
console.log("pool:", poolId);
console.log("minResourceFee (stroops):", sim.minResourceFee);
if (sim.result) {
  console.log("denomination:", scValToNative(sim.result.retval).toString());
}
