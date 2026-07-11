// In-process pubsub for the one live query (a user's project list). Mutations
// that change a project — or its files, which bump the parent's updated_at via
// DB trigger — publish the owner's id; matching subscriptions re-execute.
//
// Scope note: like-for-like with Hasura this is slightly narrower — Hasura's
// 1s live-query poll would also pick up out-of-band SQL edits. Every project
// write goes through this api, so in practice nothing is lost.

import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const PROJECT_EVENT = "project";

export function publishProjectChange(ownerUserId: string | null): void {
    if (ownerUserId) emitter.emit(PROJECT_EVENT, ownerUserId);
}

export function onProjectChange(
    listener: (ownerUserId: string) => void,
): () => void {
    emitter.on(PROJECT_EVENT, listener);
    return () => emitter.off(PROJECT_EVENT, listener);
}
