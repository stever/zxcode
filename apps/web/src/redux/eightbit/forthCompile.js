import axios from "axios";
import gql from "graphql-tag";
import {print} from "graphql";
import Constants from "../../constants";
import {getAuthToken, isExpired, refreshToken} from "../../auth";
import {extractCompilerError} from "./zxbasicCompile";

const COMPILE_MUTATION = gql`
    mutation ($code: String!) {
        compileForth(code: $code) {
            base64_encoded
            sld
        }
    }
`;

// Compile via the zenv service and return {tap, debug}: the zenv Forth
// system with the user's program embedded, evaluated line by line at boot
// before landing at the interactive ok prompt, plus the debugger's
// linecall map ({kind: "forth", anchor, lines: [...]} parsed from the
// JSON in CompileResult.sld; null when the service produced none). zenv
// compiles words at runtime, so the map is Boriel-style — a per-line
// runtime marker anchored at a fixed address — not a line→address map.
// No machine parameter (the image is a 48K program that runs on every
// model). Forth errors surface at runtime on the Spectrum screen, like
// BASIC; a compile failure here means an oversized program or a service
// error. On failure it throws an array of build-error items ({type:
// 'err', text}) - the same shape the other compilers reject with - so the
// saga surfaces them as build-error toasts rather than the full-page
// error banner.
//
// It is guaranteed to only ever throw an array of items: any unexpected error
// (token refresh, malformed payload, ...) is normalised too, so a failure can
// never surface as silence.
export async function getForthTap(code, userId) {
    console.log("[zenv] compile requested", {codeLength: code?.length, userId});
    try {
        const result = await compile(code, userId);
        console.log("[zenv] compile succeeded", {
            bytes: result.tap.length,
            debugLines: result.debug?.lines?.length ?? 0,
        });
        return result;
    } catch (e) {
        // Re-throw our own build-error arrays unchanged; wrap anything else.
        if (Array.isArray(e)) {
            console.error("[zenv] compile failed", e);
            throw e;
        }
        console.error("[zenv] compile failed (unexpected)", e);
        throw [{type: "err", text: e?.message || String(e) || "Compilation failed."}];
    }
}

async function compile(code, userId) {
    const variables = {code};

    // Match gqlFetch: anonymous requests carry no token at all.
    let jwt = userId ? getAuthToken() : null;
    if (jwt && isExpired(jwt)) {
        jwt = await refreshToken();
    }

    const headers = {"Content-Type": "application/json"};
    if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

    let envelope;
    try {
        const response = await axios.post(Constants.graphQlEndpoint, {
            query: print(COMPILE_MUTATION),
            variables,
        }, {headers});
        envelope = response.data;
    } catch (e) {
        console.error("[zenv] transport error", e?.response?.status, e?.response?.data || e);
        throw [{type: "err", text: extractCompilerError(undefined, e)}];
    }

    if (envelope?.errors?.length > 0) {
        console.error("[zenv] GraphQL errors in envelope", envelope.errors);
        throw [{type: "err", text: extractCompilerError(envelope)}];
    }

    // noinspection JSUnresolvedVariable
    const base64 = envelope?.data?.compileForth?.base64_encoded;
    if (!base64) {
        throw [{type: "err", text: "Compilation produced no output."}];
    }

    // The debug map is best-effort on the service side; a missing or
    // malformed one must never fail the compile.
    let debug = null;
    const sld = envelope?.data?.compileForth?.sld;
    if (sld) {
        try {
            const parsed = JSON.parse(sld);
            if (parsed?.kind === "forth"
                && Number.isInteger(parsed.anchor)
                && Array.isArray(parsed.lines)) {
                debug = parsed;
            }
        } catch (e) {
            console.warn("[zenv] unparseable debug map ignored", e);
        }
    }

    // noinspection JSDeprecatedSymbols
    return {
        tap: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
        debug,
    };
}
