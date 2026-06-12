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
import { server, horizon } from "../stellar/rpc.js";
import { withMasterSequence } from "../stellar/master.js";
import { recordEphemeral, forgetEphemeral, mergeEphemeral } from "./ephemerals.js";
import type { Channel } from "../channels/pool.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

const NET = config.STELLAR_NETWORK_PASSPHRASE;

// The pool panics with this exact message when a nullifier is already spent. It is the only signal
// that distinguishes an already-revealed note (a success: the recipient was paid) from a genuine
// rejection, so it is a deliberate coupling to the contract: keep it in sync with the pool's panic.
const NULLIFIER_SPENT_PANIC = "nullifier already used";

const FEE_BUMP_REVEAL = String(parseInt(BASE_FEE, 10) * 100);
const FEE_BUMP_MERGE = String(parseInt(BASE_FEE, 10) * 10);
const FEE_SPONSOR = String(parseInt(BASE_FEE, 10) * 3);

export interface RevealJob {
  id: string;
  pool: string;
  proof: string;
  root: string;
  nullifierHash: string;
  amountHash: string;
  recipient: string;
  // The master whose key the client bound into the proof as the fee recipient. The channel handling
  // this job belongs to this master, so the reveal pays the fee to it and it fee-bumps the gas.
  relayer: string;
  xlmFee: string;
}

export type RevealResult =
  | { ok: true; txHash: string; observedFee: number }
  | { ok: false; reason: string };

// Runs the full reveal for one job on one channel: sponsor a throwaway ephemeral (so the relayer's
// wallet is never the reveal source), simulate to verify the proof and price the gas, restore any
// archived pool state, submit the reveal fee-bumped by the channel's master, then merge the ephemeral
// back so its sponsored reserve returns to the channel. Simulation is the economic gate: an invalid
// proof fails it (no gas spent) and a fee below the simulated gas is refused before anything runs.
export async function executeReveal(job: RevealJob, channel: Channel): Promise<RevealResult> {
  const master = channel.master;
  const revealOp = buildRevealOp(job);

  // Simulate before creating anything. The reveal operation does not depend on the transaction
  // source, so simulating from the master account is equivalent, and it lets an invalid proof or a
  // fee below gas be rejected without spending a sponsor and merge on a throwaway ephemeral.
  const sim = await simulateReveal(master.publicKey(), revealOp);
  if (rpc.Api.isSimulationError(sim)) {
    // A spent nullifier means this note was already revealed (by us on a lost-confirmation retry,
    // or by the user self-revealing): the recipient was paid, so it is a success, not a rejection.
    return sim.error.includes(NULLIFIER_SPENT_PANIC)
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
    await restoreFootprint(master, sim.restorePreamble);
  }

  const ephemeral = Keypair.random();
  // Persist before sponsoring so a crash between sponsor and merge cannot strand the reserve: the
  // sweep finds the record and merges it back.
  await recordEphemeral(ephemeral, channel.keypair.publicKey(), job.id);
  try {
    await sponsorEphemeral(channel.keypair, ephemeral);
    const txHash = await submitReveal(master, ephemeral, revealOp);
    return { ok: true, txHash, observedFee: Number(sim.minResourceFee) };
  } finally {
    // Recover the sponsored reserve and drop the record. On failure the record stays so the sweep
    // reclaims it later; the reserve is never permanently leaked.
    await mergeEphemeral(channel.keypair.publicKey(), ephemeral, master)
      .then(() => forgetEphemeral(ephemeral.publicKey()))
      .catch((err) =>
        logger.warn(
          { err, ephemeral: ephemeral.publicKey(), channel: channel.keypair.publicKey() },
          "merge failed, reserve will be reclaimed by sweep",
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
    nativeToScVal(job.relayer, { type: "address" }),
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

async function submitReveal(
  master: Keypair,
  ephemeral: Keypair,
  revealOp: xdr.Operation,
): Promise<string> {
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
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(master, bumpFee, prepared, NET);
  feeBump.sign(master);
  // Submit through Horizon: the Soroban RPC's getTransaction cannot parse a fee-bump result and
  // throws, even though the reveal itself succeeds.
  const result = await horizon.submitTransaction(feeBump);
  return result.hash;
}

type RestorePreamble = rpc.Api.SimulateTransactionRestoreResponse["restorePreamble"];

async function restoreFootprint(master: Keypair, preamble: RestorePreamble): Promise<void> {
  // Restores run from inside parallel reveals and consume the master's sequence, so they are
  // serialized per master with each other and with the maintenance loop's master-sourced submissions.
  await withMasterSequence(master.publicKey(), async () => {
    const account = await server.getAccount(master.publicKey());
    const fee = (BigInt(BASE_FEE) + BigInt(preamble.minResourceFee)).toString();
    const tx = new TransactionBuilder(account, { fee, networkPassphrase: NET })
      .setSorobanData(preamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(60)
      .build();
    tx.sign(master);
    // Submit through Horizon: the Soroban RPC's getTransaction cannot parse this result and throws.
    await horizon.submitTransaction(tx);
  });
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
