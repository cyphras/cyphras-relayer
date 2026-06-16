// Liveness beacons for the background loops. A service worker process can be up (answering HTTP) while
// its indexer or executor loop is wedged; health reads these to tell a stalled loop from a healthy one
// without scraping logs.
const beats = new Map<string, number>();

export function beat(name: string): void {
  beats.set(name, Date.now());
}

export function lastBeat(name: string): number | null {
  return beats.get(name) ?? null;
}
