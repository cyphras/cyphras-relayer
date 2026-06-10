import { scValToNative, rpc } from "@stellar/stellar-sdk";

const COMMIT_EVENT_NAME = "commit_event";

export interface CommitLeaf {
  leafIndex: number;
  commitment: string;
  root: string;
  ledger: number;
}

export function isCommitEvent(event: rpc.Api.EventResponse): boolean {
  return scValToNative(event.topic[0]) === COMMIT_EVENT_NAME;
}

export function parseCommitEvent(event: rpc.Api.EventResponse): CommitLeaf {
  const commitment = (scValToNative(event.topic[1]) as Buffer).toString("hex");
  const value = scValToNative(event.value) as { leaf_index: number; root: Buffer };
  return {
    leafIndex: value.leaf_index,
    commitment,
    root: value.root.toString("hex"),
    ledger: event.ledger,
  };
}
