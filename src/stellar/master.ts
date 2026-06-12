// Serializes every sequence-consuming submission on the master account (channel funding, TTL
// extends, restores). Restores fire from parallel reveals, so without this two would load the same
// sequence and all but one fail with a bad sequence. Fee bumps consume no sequence and stay off this lock.
let tail: Promise<unknown> = Promise.resolve();

export function withMasterSequence<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
