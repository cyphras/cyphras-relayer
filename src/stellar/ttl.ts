import {
  Operation,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Address,
  Contract,
  SorobanDataBuilder,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import { server, horizon, relayerKeypair } from "./rpc.js";
import { withMasterSequence } from "./master.js";
import { config } from "../config/index.js";

const NET = config.STELLAR_NETWORK_PASSPHRASE;

function instanceKey(contractId: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function codeKey(wasmHash: Buffer): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
}

// The ledger until which the contract's instance storage stays live, or null if the contract is
// gone. The whole commit working set rides this single TTL (it lives in instance storage).
export async function instanceLiveUntil(contractId: string): Promise<number | null> {
  const { entries } = await server.getLedgerEntries(instanceKey(contractId));
  return entries[0]?.liveUntilLedgerSeq ?? null;
}

// The Wasm hash backing a contract instance, read from its executable, or null for a missing
// contract or a built-in (Stellar asset) executable that has no separate code entry to keep alive.
export async function contractWasmHash(contractId: string): Promise<Buffer | null> {
  const { entries } = await server.getLedgerEntries(instanceKey(contractId));
  const entry = entries[0];
  if (!entry) {
    return null;
  }
  const executable = entry.val.contractData().val().instance().executable();
  if (executable.switch().name !== "contractExecutableWasm") {
    return null;
  }
  return executable.wasmHash();
}

export async function codeLiveUntil(wasmHash: Buffer): Promise<number | null> {
  const { entries } = await server.getLedgerEntries(codeKey(wasmHash));
  return entries[0]?.liveUntilLedgerSeq ?? null;
}

// Extends the TTL of one or more ledger entries so they live at least `extendLedgers` more ledgers
// from now (a relative amount, capped by the network max entry TTL). Raising only, so it is safe to
// repeat; paid from the relayer wallet and serialized on the master sequence.
async function extendTtl(
  keys: xdr.LedgerKey[],
  extendLedgers: number,
  label: string,
): Promise<void> {
  await withMasterSequence(relayerKeypair.publicKey(), async () => {
    const sorobanData = new SorobanDataBuilder().setReadOnly(keys).build();
    const account = await server.getAccount(relayerKeypair.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NET })
      .setSorobanData(sorobanData)
      .addOperation(Operation.extendFootprintTtl({ extendTo: extendLedgers }))
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`extend ttl simulation failed for ${label}: ${sim.error}`);
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(relayerKeypair);
    // Submit through Horizon: the Soroban RPC's getTransaction cannot parse this result and throws.
    await horizon.submitTransaction(prepared);
  });
}

export function extendInstanceTtl(contractId: string, extendLedgers: number): Promise<void> {
  return extendTtl([instanceKey(contractId)], extendLedgers, contractId);
}

// Keeps the contract's code entry alive. Code is archive-and-restorable, so a long-idle contract
// would otherwise force a restore on its next call; extending it proactively avoids that latency.
export function extendCodeTtl(wasmHash: Buffer, extendLedgers: number): Promise<void> {
  return extendTtl(
    [codeKey(wasmHash)],
    extendLedgers,
    `code ${wasmHash.toString("hex").slice(0, 8)}`,
  );
}

// Extends persistent data entries the instance keeper does not cover (the pool's root state and the
// factory registry). Soroban archives those once their TTL lapses, which would make old notes
// unrevealable and pools undiscoverable until a restore; the contracts are written expecting this
// off-chain keeper to keep them live.
export function extendPersistentTtl(
  keys: xdr.LedgerKey[],
  extendLedgers: number,
  label: string,
): Promise<void> {
  return extendTtl(keys, extendLedgers, label);
}

function isPersistentData(key: xdr.LedgerKey): boolean {
  if (key.switch().name !== "contractData") {
    return false;
  }
  const data = key.contractData();
  return (
    data.durability().name === "persistent" &&
    data.key().switch().name !== "scvLedgerKeyContractInstance"
  );
}

// Simulates a read-only call and returns both its decoded result and the persistent (non-instance)
// ledger keys it touches. Harvesting keys from the host-computed footprint means the relayer never
// has to mirror the contract's storage-key encoding to find the entries it must keep alive.
export async function readWithPersistentKeys(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<{ value: unknown; persistentKeys: xdr.LedgerKey[] }> {
  const account = await server.getAccount(relayerKeypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`footprint simulation failed for ${method}: ${sim.error}`);
  }
  const footprint = sim.transactionData.build().resources().footprint();
  const persistentKeys = [...footprint.readOnly(), ...footprint.readWrite()].filter(
    isPersistentData,
  );
  const value = sim.result ? scValToNative(sim.result.retval) : undefined;
  return { value, persistentKeys };
}

// The soonest ledger at which any of these entries archives, or null if any is missing (so a caller
// treats an absent entry as "do not extend" rather than as having infinite headroom).
export async function minLiveUntil(keys: xdr.LedgerKey[]): Promise<number | null> {
  if (keys.length === 0) {
    return null;
  }
  const { entries } = await server.getLedgerEntries(...keys);
  if (entries.length < keys.length) {
    return null;
  }
  return entries.reduce<number | null>((min, entry) => {
    const live = entry.liveUntilLedgerSeq ?? null;
    if (live === null) {
      return min;
    }
    return min === null ? live : Math.min(min, live);
  }, null);
}
