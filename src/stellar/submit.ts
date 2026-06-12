import { type Transaction, type FeeBumpTransaction } from "@stellar/stellar-sdk";
import { server } from "./rpc.js";

const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 60000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submits a signed transaction and polls until it is confirmed, returning its hash. Throws on
 * rejection, on-chain failure, or timeout.
 */
export async function submitAndWait(
  tx: Transaction | FeeBumpTransaction,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`transaction rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await server.getTransaction(sent.hash);
    if (res.status === "SUCCESS") {
      return sent.hash;
    }
    if (res.status === "FAILED") {
      throw new Error(`transaction ${sent.hash} failed on-chain`);
    }
    if (Date.now() > deadline) {
      throw new Error(`transaction ${sent.hash} not confirmed within ${timeoutMs}ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
