// WebSocket subscriptions, speaking the exact dialect of the hand-rolled
// client in apps/web/src/graphql_subscription_client.js: the legacy
// subscriptions-transport-ws message vocabulary (connection_init/ack/ka/
// start/data/stop/complete) under the subprotocol name "graphql-ws".
//
// A subscription is re-executed as a plain query whenever the pubsub reports
// a project change for the connection's user. When the JWT expires the socket
// closes with a non-1000 code — the client saga treats that as "reconnect",
// refreshing the token first, which mirrors how Hasura connections cycled.

import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { execute, parse, validate, type DocumentNode } from "graphql";
import { schema } from "./schema.js";
import { authenticate } from "./auth.js";
import { formatError } from "./errors.js";
import { onProjectChange } from "./pubsub.js";
import type { Session } from "./tables.js";
import type { Context } from "./resolvers.js";

const KEEP_ALIVE_MS = 15_000;
const CLOSE_JWT_EXPIRED = 4403;

interface StartPayload {
    query?: string;
    variables?: Record<string, unknown>;
    operationName?: string | null;
}

interface ClientMessage {
    type?: string;
    id?: string;
    payload?: Record<string, unknown>;
}

class Connection {
    private session: Session | null = null;
    private readonly subscriptions = new Map<
        string,
        { unsubscribe: () => void }
    >();
    private keepAliveTimer: NodeJS.Timeout | null = null;
    private expiryTimer: NodeJS.Timeout | null = null;

    constructor(private readonly ws: WebSocket) {
        ws.on("message", (raw) => {
            void this.onMessage(String(raw));
        });
        ws.on("close", () => this.cleanup());
        ws.on("error", () => this.cleanup());
    }

    private send(message: Record<string, unknown>): void {
        if (this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private cleanup(): void {
        for (const { unsubscribe } of this.subscriptions.values()) unsubscribe();
        this.subscriptions.clear();
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        if (this.expiryTimer) clearTimeout(this.expiryTimer);
        this.keepAliveTimer = null;
        this.expiryTimer = null;
    }

    private async onMessage(raw: string): Promise<void> {
        let message: ClientMessage;
        try {
            message = JSON.parse(raw) as ClientMessage;
        } catch {
            this.send({ type: "connection_error", payload: "invalid JSON" });
            return;
        }

        switch (message.type) {
            case "connection_init":
                await this.onConnectionInit(message.payload ?? {});
                break;
            case "start":
                await this.onStart(
                    message.id ?? "",
                    (message.payload ?? {}) as StartPayload,
                );
                break;
            case "stop":
                this.onStop(message.id ?? "");
                break;
            case "connection_terminate":
                this.cleanup();
                this.ws.close(1000);
                break;
            default:
                break;
        }
    }

    private async onConnectionInit(payload: Record<string, unknown>): Promise<void> {
        const rawHeaders = (payload.headers ?? {}) as Record<string, unknown>;
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawHeaders)) {
            if (typeof value === "string") headers[key.toLowerCase()] = value;
        }

        try {
            const { session, expiresAt } = await authenticate(headers);
            this.session = session;
            this.send({ type: "connection_ack" });
            this.send({ type: "ka" });
            this.keepAliveTimer = setInterval(
                () => this.send({ type: "ka" }),
                KEEP_ALIVE_MS,
            );
            if (expiresAt !== null) {
                const delay = Math.max(0, expiresAt - Date.now());
                this.expiryTimer = setTimeout(() => {
                    // Non-1000 close: the client reconnects with a fresh JWT.
                    this.ws.close(CLOSE_JWT_EXPIRED, "JWT expired");
                }, delay);
            }
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.send({ type: "connection_error", payload: { message: reason } });
            this.ws.close(CLOSE_JWT_EXPIRED, "authentication failed");
        }
    }

    private async onStart(id: string, payload: StartPayload): Promise<void> {
        if (!this.session) {
            this.send({
                type: "error",
                id,
                payload: { message: "connection_init required first" },
            });
            return;
        }
        if (!id || typeof payload.query !== "string") {
            this.send({ type: "error", id, payload: { message: "invalid start payload" } });
            return;
        }

        let document: DocumentNode;
        try {
            document = parse(payload.query);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.send({ type: "error", id, payload: { message: reason } });
            return;
        }
        const validationErrors = validate(schema, document);
        if (validationErrors.length > 0) {
            this.send({
                type: "error",
                id,
                payload: { message: validationErrors.map((e) => e.message).join("; ") },
            });
            return;
        }

        const session = this.session;
        const run = async (): Promise<void> => {
            const result = await execute({
                schema,
                document,
                variableValues: payload.variables ?? {},
                operationName: payload.operationName ?? undefined,
                contextValue: { session, headers: {} } satisfies Context,
            });
            const frame: Record<string, unknown> = { data: result.data ?? null };
            if (result.errors?.length) {
                frame.errors = result.errors.map((e) => formatError(e));
            }
            this.send({ type: "data", id, payload: frame });
        };

        const isSubscription = document.definitions.some(
            (d) =>
                d.kind === "OperationDefinition" && d.operation === "subscription",
        );

        await run();

        if (!isSubscription) {
            this.send({ type: "complete", id });
            return;
        }

        // The only live query filters to the session user's own projects, so
        // owner-scoped events are a precise trigger. Broader subscriptions
        // would just keep serving their initial result.
        const unsubscribe = onProjectChange((ownerUserId) => {
            if (session.role === "admin" || ownerUserId === session.userId) {
                void run();
            }
        });
        this.subscriptions.set(id, { unsubscribe });
    }

    private onStop(id: string): void {
        const entry = this.subscriptions.get(id);
        if (entry) {
            entry.unsubscribe();
            this.subscriptions.delete(id);
        }
        this.send({ type: "complete", id });
    }
}

export function attachSubscriptionServer(server: Server, path: string): void {
    const wss = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) =>
            protocols.has("graphql-ws") ? "graphql-ws" : false,
    });

    wss.on("connection", (ws: WebSocket) => {
        new Connection(ws);
    });

    server.on("upgrade", (request: IncomingMessage, socket, head) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== path) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit("connection", ws, request);
        });
    });
}
