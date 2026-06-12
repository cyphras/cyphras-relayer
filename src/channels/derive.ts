import { createHmac } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

// Channel keypairs are derived from the master secret, so they need no separate storage and can be
// regenerated on any host. A master compromise already exposes everything, so deriving the
// low-value channel keys from it adds no meaningful risk.
export function deriveChannels(master: Keypair, count: number): Keypair[] {
  const seed = Buffer.from(master.rawSecretKey());
  const channels: Keypair[] = [];
  for (let i = 0; i < count; i++) {
    const derived = createHmac("sha256", seed).update(`cyphras-channel-${i}`).digest();
    channels.push(Keypair.fromRawEd25519Seed(derived));
  }
  return channels;
}
