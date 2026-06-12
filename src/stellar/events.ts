import { scValToNative, rpc } from "@stellar/stellar-sdk";

const COMMIT_EVENT_NAME = "commit_event";
const POOL_CREATED_EVENT_NAME = "pool_created";

export interface CommitLeaf {
  leafIndex: number;
  commitment: string;
  root: string;
  ledger: number;
}

export interface PoolCreated {
  pool: string;
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

export function isPoolCreatedEvent(event: rpc.Api.EventResponse): boolean {
  return scValToNative(event.topic[0]) === POOL_CREATED_EVENT_NAME;
}

export function parsePoolCreatedEvent(event: rpc.Api.EventResponse): PoolCreated {
  const value = scValToNative(event.value) as { pool: string };
  return {
    pool: value.pool,
    ledger: event.ledger,
  };
}
