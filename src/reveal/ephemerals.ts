import { Keypair, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";
import { horizon, relayerKeypair } from "../stellar/rpc.js";
import { config } from "../config/index.js";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";

const NET = config.STELLAR_NETWORK_PASSPHRASE;
const FEE_BUMP_MERGE = String(parseInt(BASE_FEE, 10) * 10);
// Only sweep ephemerals older than this. It must exceed the worst-case reveal flow (sponsor +
// submit, each a 60s-timeout Horizon call, plus the inline merge), so the sweep can never merge an
// account a still-running reveal is mid-flight on. A record this old means the flow finished or the
// process died, so reclaiming its reserve is safe.
const SWEEP_MIN_AGE = "10 minutes";

// The ephemeral holds no balance, only the reserve the channel sponsors for it. Persisting it lets a
// later sweep merge it back if the inline merge is lost to a crash, so the reserve is never leaked.
// The secret is safe at rest: the account has zero spendable balance and merging it only returns the
// reserve to our own channel.
export async function recordEphemeral(
  ephemeral: Keypair,
  channel: string,
  jobId: string,
): Promise<void> {
  await db.query(
    "insert into ephemerals (pubkey, secret, channel, job_id) values ($1, $2, $3, $4)",
    [ephemeral.publicKey(), ephemeral.secret(), channel, jobId],
  );
}

export async function forgetEphemeral(pubkey: string): Promise<void> {
  await db.query("delete from ephemerals where pubkey = $1", [pubkey]);
}

// Merges the ephemeral back into its channel, returning the sponsored reserve. The master fee-bumps
// because the ephemeral has no balance. The channel is referenced by public key only (the merge
// destination), so no channel signature is needed and the sweep can run from a stored record.
export async function mergeEphemeral(channel: string, ephemeral: Keypair): Promise<void> {
  const account = await horizon.loadAccount(ephemeral.publicKey());
  const inner = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(Operation.accountMerge({ destination: channel }))
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

// Reclaims any ephemeral whose inline merge did not complete (relayer crash, merge failure). Only
// touches records past a short age so it never races a reveal still finishing its own merge. A
// missing account means it was already merged, so the record is dropped.
export async function sweepEphemerals(): Promise<number> {
  const { rows } = await db.query<{ pubkey: string; secret: string; channel: string }>(
    `select pubkey, secret, channel from ephemerals where created_at < now() - interval '${SWEEP_MIN_AGE}'`,
  );
  let reclaimed = 0;
  for (const row of rows) {
    try {
      await mergeEphemeral(row.channel, Keypair.fromSecret(row.secret));
      await forgetEphemeral(row.pubkey);
      reclaimed += 1;
    } catch (err) {
      if (isNotFound(err)) {
        await forgetEphemeral(row.pubkey);
      } else {
        logger.warn({ err, ephemeral: row.pubkey }, "sweep merge failed, will retry next cycle");
      }
    }
  }
  return reclaimed;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { status?: number } }).response?.status === 404
  );
}
