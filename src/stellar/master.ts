// Serializes every sequence-consuming submission per master account (channel funding, TTL extends,
// restores). Restores fire from parallel reveals, so without this two on the same master would load
// the same sequence and all but one fail with a bad sequence. Fee bumps consume no sequence and
// stay off this lock.
const tails = new Map<string, Promise<unknown>>();

export function withMasterSequence<T>(masterPublicKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(masterPublicKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    masterPublicKey,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
