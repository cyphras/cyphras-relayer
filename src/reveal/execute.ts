import {
  Keypair,
  Operation,
  TransactionBuilder,
  Contract,
  BASE_FEE,
  nativeToScVal,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import { server, horizon, relayerKeypair } from "../stellar/rpc.js";
import { submitAndWait } from "../stellar/submit.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

const NET = config.STELLAR_NETWORK_PASSPHRASE;
const FEE_BUMP_REVEAL = String(parseInt(BASE_FEE, 10) * 100);
const FEE_BUMP_MERGE = String(parseInt(BASE_FEE, 10) * 10);
const FEE_SPONSOR = String(parseInt(BASE_FEE, 10) * 3);

export interface RevealJob {
  pool: string;
  proof: string;
  root: string;
  nullifierHash: string;
  amountHash: string;
  recipient: string;
  xlmFee: string;
}

export type RevealResult = { ok: true; txHash: string } | { ok: false; reason: string };

// Runs the full reveal for one job on one channel: sponsor a throwaway ephemeral (so the relayer's
// wallet is never the reveal source), simulate to verify the proof and price the gas, restore any
// archived pool state, submit the reveal fee-bumped by the master, then merge the ephemeral back so
// its sponsored reserve returns to the channel. Simulation is the economic gate: an invalid proof
// fails it (no gas spent) and a fee below the simulated gas is refused before anything is submitted.
export async function executeReveal(job: RevealJob, channel: Keypair): Promise<RevealResult> {
  const revealOp = buildRevealOp(job);

  // Simulate before creating anything. The reveal operation does not depend on the transaction
  // source, so simulating from the master account is equivalent, and it lets an invalid proof or a
  // fee below gas be rejected without spending a sponsor and merge on a throwaway ephemeral.
  const sim = await simulateReveal(relayerKeypair.publicKey(), revealOp);
  if (rpc.Api.isSimulationError(sim)) {
    // A spent nullifier means this note was already revealed (by us on a lost-confirmation retry,
    // or by the user self-revealing): the recipient was paid, so it is a success, not a rejection.
    return sim.error.includes("nullifier already used")
      ? { ok: false, reason: "already_revealed" }
      : { ok: false, reason: "rejected_by_simulation" };
  }

  // The locked fee must cover the whole flow the relayer pays for: the reveal resource fee plus the
  // sponsor, merge, and fee-bump inclusion, not just the resource fee.
  const flowOverhead = BigInt(FEE_BUMP_REVEAL) + BigInt(FEE_BUMP_MERGE) + BigInt(FEE_SPONSOR);
  if (BigInt(job.xlmFee) < BigInt(sim.minResourceFee) + flowOverhead) {
    return { ok: false, reason: "fee_below_gas" };
  }

  // Restore archived pool state first. It is master-sourced and needs no ephemeral, so a restore
  // failure never wastes a sponsor or merge.
  if (rpc.Api.isSimulationRestore(sim)) {
    await restoreFootprint(sim.restorePreamble);
  }

  const ephemeral = Keypair.random();
  try {
    await sponsorEphemeral(channel, ephemeral);
    const txHash = await submitReveal(ephemeral, revealOp);
    return { ok: true, txHash };
  } finally {
    // Recover the sponsored reserve. Best-effort, but a failure leaks the reserve on the channel,
    // so log it: the ephemeral still exists and can be merged back later.
    await mergeEphemeral(channel, ephemeral).catch((err) =>
      logger.warn(
        { err, ephemeral: ephemeral.publicKey(), channel: channel.publicKey() },
        "merge failed, sponsored reserve leaked",
      ),
    );
  }
}

function buildRevealOp(job: RevealJob): xdr.Operation {
  const bytes = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
  return new Contract(job.pool).call(
    "reveal",
    bytes(job.proof),
    bytes(job.root),
    bytes(job.nullifierHash),
    bytes(job.amountHash),
    nativeToScVal(job.recipient, { type: "address" }),
    nativeToScVal(relayerKeypair.publicKey(), { type: "address" }),
    nativeToScVal(BigInt(job.xlmFee), { type: "i128" }),
  );
}

async function simulateReveal(
  sourcePublicKey: string,
  revealOp: xdr.Operation,
): Promise<rpc.Api.SimulateTransactionResponse> {
  const account = await server.getAccount(sourcePublicKey);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(revealOp)
    .setTimeout(60)
    .build();
  return server.simulateTransaction(tx);
}

async function submitReveal(ephemeral: Keypair, revealOp: xdr.Operation): Promise<string> {
  const account = await server.getAccount(ephemeral.publicKey());
  const base = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(revealOp)
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(base);
  prepared.sign(ephemeral);

  // The fee bump must bid at least the inner reveal's fee, which is dominated by the BN254
  // verification resource fee, plus headroom for the bump's own inclusion.
  const bumpFee = (BigInt(prepared.fee) + BigInt(FEE_BUMP_REVEAL)).toString();
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    relayerKeypair,
    bumpFee,
    prepared,
    NET,
  );
  feeBump.sign(relayerKeypair);
  // Submit through Horizon: the Soroban RPC's getTransaction cannot parse a fee-bump result and
  // throws, even though the reveal itself succeeds.
  const result = await horizon.submitTransaction(feeBump);
  return result.hash;
}

type RestorePreamble = rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"];

async function restoreFootprint(preamble: RestorePreamble): Promise<void> {
  const master = await server.getAccount(relayerKeypair.publicKey());
  const fee = (BigInt(BASE_FEE) + BigInt(preamble.minResourceFee)).toString();
  const tx = new TransactionBuilder(master, { fee, networkPassphrase: NET })
    .setSorobanData(preamble.transactionData.build())
    .addOperation(Operation.restoreFootprint({}))
    .setTimeout(60)
    .build();
  tx.sign(relayerKeypair);
  await submitAndWait(tx);
}

// The channel is both the source and the sponsor, so its sequence (not the master's) is consumed,
// which is what lets reveals run in parallel across channels.
async function sponsorEphemeral(channel: Keypair, ephemeral: Keypair): Promise<void> {
  const account = await horizon.loadAccount(channel.publicKey());
  const tx = new TransactionBuilder(account, { fee: FEE_SPONSOR, networkPassphrase: NET })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: ephemeral.publicKey() }))
    .addOperation(
      Operation.createAccount({ destination: ephemeral.publicKey(), startingBalance: "0" }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: ephemeral.publicKey() }))
    .setTimeout(60)
    .build();
  tx.sign(channel, ephemeral);
  await horizon.submitTransaction(tx);
}

// The ephemeral holds no balance, so the master fee-bumps the merge. Merging to the channel returns
// the sponsored reserve to it.
async function mergeEphemeral(channel: Keypair, ephemeral: Keypair): Promise<void> {
  const account = await horizon.loadAccount(ephemeral.publicKey());
  const inner = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(Operation.accountMerge({ destination: channel.publicKey() }))
    .setTimeout(60)
    .build();
  inner.sign(ephemeral);

  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    relayerKeypair,
    FEE_BUMP_MERGE,
    inner,
    NET,
  );
  feeBump.sign(relayerKeypair);
  await horizon.submitTransaction(feeBump);
}
