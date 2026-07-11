// The four compile mutations, previously Hasura actions. The compile services
// are unchanged: they still receive the Hasura action envelope (input +
// session_variables + action name) and the forwarded client headers they use
// for rate limiting, and still answer 2xx CompileResult / non-2xx {message}.

import { GraphQLError } from "graphql";
import type { Session } from "./tables.js";

interface ActionDefinition {
    url: string;
}

const ACTIONS: Record<string, ActionDefinition> = {
    compile: { url: process.env.ZXBASIC_URL ?? "http://zxbasic/compile/" },
    compileC: { url: process.env.Z88DK_URL ?? "http://z88dk/compile/" },
    compileSjasmplus: {
        url: process.env.SJASMPLUS_URL ?? "http://sjasmplus/compile/",
    },
    compilePascal: { url: process.env.PASTA80_URL ?? "http://pasta80/compile/" },
};

const TIMEOUT_MS = parseInt(process.env.ACTION_TIMEOUT_MS ?? "120000", 10);

const FORWARDED_HEADERS = ["authorization", "x-forwarded-for", "x-real-ip"];

export interface CompileResult {
    base64_encoded: string;
    sld?: string | null;
}

export async function runAction(
    name: string,
    input: Record<string, unknown>,
    session: Session,
    clientHeaders: Record<string, string | string[] | undefined>,
): Promise<CompileResult> {
    const action = ACTIONS[name];
    if (!action) throw new GraphQLError(`unknown action: ${name}`);

    const sessionVariables: Record<string, string> = {
        "x-hasura-role": session.role,
    };
    if (session.userId) sessionVariables["x-hasura-user-id"] = session.userId;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const header of FORWARDED_HEADERS) {
        const value = clientHeaders[header];
        const single = Array.isArray(value) ? value[0] : value;
        if (single) headers[header] = single;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(action.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                action: { name },
                input,
                session_variables: sessionVariables,
                request_query: "",
            }),
            signal: controller.signal,
        });

        const body = (await response.json().catch(() => null)) as
            | Record<string, unknown>
            | null;

        if (!response.ok) {
            const message =
                typeof body?.message === "string"
                    ? body.message
                    : `${name} handler returned ${response.status}`;
            throw new GraphQLError(message);
        }
        if (!body || typeof body.base64_encoded !== "string") {
            throw new GraphQLError(`${name} handler returned no output`);
        }
        return {
            base64_encoded: body.base64_encoded,
            sld: typeof body.sld === "string" ? body.sld : null,
        };
    } catch (err) {
        if (controller.signal.aborted) {
            throw new GraphQLError(`${name} timed out after ${TIMEOUT_MS}ms`);
        }
        if (err instanceof GraphQLError) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        throw new GraphQLError(`${name} failed: ${reason}`);
    } finally {
        clearTimeout(timer);
    }
}
