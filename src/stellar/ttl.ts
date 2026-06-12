import {
  Operation,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Address,
  SorobanDataBuilder,
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

// Extends the TTL of one ledger entry so it lives at least `extendLedgers` more ledgers from now
// (a relative amount, capped by the network max entry TTL). Raising only, so it is safe to repeat;
// paid from the relayer wallet and serialized on the master sequence.
async function extendTtl(key: xdr.LedgerKey, extendLedgers: number, label: string): Promise<void> {
  await withMasterSequence(relayerKeypair.publicKey(), async () => {
    const sorobanData = new SorobanDataBuilder().setReadOnly([key]).build();
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
  return extendTtl(instanceKey(contractId), extendLedgers, contractId);
}

// Keeps the contract's code entry alive. Code is archive-and-restorable, so a long-idle contract
// would otherwise force a restore on its next call; extending it proactively avoids that latency.
export function extendCodeTtl(wasmHash: Buffer, extendLedgers: number): Promise<void> {
  return extendTtl(
    codeKey(wasmHash),
    extendLedgers,
    `code ${wasmHash.toString("hex").slice(0, 8)}`,
  );
}
