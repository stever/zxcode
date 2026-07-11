// HTTP transport: POST /v1/graphql with the Hasura response envelope
// (always 200 with { data, errors }) and GET /healthz for the compose/docs
// readiness gate. The reverse proxy strips /api, so the paths here match
// what Hasura served.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { execute, parse, validate } from "graphql";
import { schema } from "./schema.js";
import { authenticate, AuthError } from "./auth.js";
import { formatError, type WireError } from "./errors.js";
import type { Context } from "./resolvers.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024; // Caddy caps /api at 16MB

interface GraphQLRequestBody {
    query?: unknown;
    variables?: unknown;
    operationName?: unknown;
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin ?? "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Hasura-Admin-Secret, Cache-Control, Pragma",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function respondJson(res: ServerResponse, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (message: string): void =>
        respondJson(res, { errors: [{ message }] });

    let session: Context["session"];
    try {
        session = (await authenticate(req.headers)).session;
    } catch (err) {
        fail(err instanceof AuthError ? err.message : "authentication failed");
        return;
    }

    let body: GraphQLRequestBody;
    try {
        body = JSON.parse(await readBody(req)) as GraphQLRequestBody;
    } catch (err) {
        fail(err instanceof Error ? err.message : "invalid request body");
        return;
    }
    if (typeof body.query !== "string") {
        fail("no query in request body");
        return;
    }

    let document;
    try {
        document = parse(body.query);
    } catch (err) {
        fail(err instanceof Error ? err.message : "could not parse query");
        return;
    }

    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) {
        respondJson(res, { errors: validationErrors.map((e) => formatError(e)) });
        return;
    }

    const contextValue: Context = { session, headers: req.headers };
    try {
        const result = await execute({
            schema,
            document,
            variableValues: (body.variables ?? {}) as Record<string, unknown>,
            operationName:
                typeof body.operationName === "string" ? body.operationName : undefined,
            contextValue,
        });
        const wire: { data?: unknown; errors?: WireError[] } = {};
        if (result.data !== undefined) wire.data = result.data;
        if (result.errors?.length) {
            wire.errors = result.errors.map((e) => formatError(e));
            for (const error of result.errors) {
                if (error.originalError && !(error.originalError instanceof AuthError)) {
                    console.error("graphql error:", error.originalError);
                }
            }
        }
        respondJson(res, wire);
    } catch (err) {
        console.error("graphql execution failed:", err);
        respondJson(res, { errors: [formatError(err)] });
    }
}

export function createServer(): http.Server {
    return http.createServer((req, res) => {
        setCors(req, res);

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "GET" && req.url === "/healthz") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
            return;
        }
        if (req.method === "POST" && req.url?.split("?")[0] === "/v1/graphql") {
            void handleGraphQL(req, res);
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
    });
}
