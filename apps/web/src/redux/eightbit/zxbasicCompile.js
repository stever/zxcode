import axios from "axios";
import gql from "graphql-tag";
import {print} from "graphql";
import Constants from "../../constants";
import {getAuthToken, isExpired, refreshToken} from "../../auth";

const COMPILE_MUTATION = gql`
    mutation ($basic: String!, $files: [ProjectFileInput!]) {
        compile(basic: $basic, files: $files) {
            base64_encoded
            sld
        }
    }
`;

// Pull a human-readable compiler message out of whatever the transport gave us.
// Boriel's diagnostics arrive as the GraphQL error message (the Hasura action
// reshapes the webhook's {message} into errors[].message); on a non-2xx the
// same payload rides on the axios error's response. Always returns a non-empty
// string so a failure can never surface as silence.
export function extractCompilerError(envelope, axiosError) {
    const errors = envelope?.errors || axiosError?.response?.data?.errors;
    if (errors?.length > 0) {
        const text = errors.map((e) => e?.message).filter(Boolean).join("\n");
        if (text) return text;
    }

    const message = axiosError?.response?.data?.message;
    if (message) return message;

    return axiosError?.message || "Compilation failed.";
}

// Compile Boriel ZX BASIC and return {tap, debug}: the TAP bytes plus the
// service's debugger line map ({kind: "zxbasic", anchor, lines} parsed from
// the JSON it sends in CompileResult.sld; null when the service produced
// none — the debugger then simply has no source map). On failure it throws
// an array of build-error items ({type: 'err', text}) - the same shape the
// other in-browser compilers reject with - so the saga surfaces them as
// build-error toasts rather than the full-page error banner that gqlFetch
// would trigger.
//
// It is guaranteed to only ever throw an array of items: any unexpected error
// (token refresh, malformed payload, ...) is normalised too, so a failure can
// never surface as silence.
export async function getZXBasicTap(code, userId, files = []) {
    console.log("[zxbasic] compile requested", {codeLength: code?.length, userId, files: files.length});
    try {
        const result = await compile(code, userId, files);
        console.log("[zxbasic] compile succeeded", {
            tapBytes: result.tap.length,
            debugLines: result.debug?.lines?.length || 0,
        });
        return result;
    } catch (e) {
        // Re-throw our own build-error arrays unchanged; wrap anything else.
        if (Array.isArray(e)) {
            console.error("[zxbasic] compile failed", e);
            throw e;
        }
        console.error("[zxbasic] compile failed (unexpected)", e);
        throw [{type: "err", text: e?.message || String(e) || "Compilation failed."}];
    }
}

async function compile(code, userId, files) {
    const variables = {basic: code, files};

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
        console.error("[zxbasic] transport error", e?.response?.status, e?.response?.data || e);
        throw [{type: "err", text: extractCompilerError(undefined, e)}];
    }

    if (envelope?.errors?.length > 0) {
        console.error("[zxbasic] GraphQL errors in envelope", envelope.errors);
        throw [{type: "err", text: extractCompilerError(envelope)}];
    }

    // noinspection JSUnresolvedVariable
    const base64 = envelope?.data?.compile?.base64_encoded;
    if (!base64) {
        throw [{type: "err", text: "Compilation produced no output."}];
    }

    // The debug map is best-effort on the service side; a missing or
    // malformed one must never fail the compile.
    let debug = null;
    const sld = envelope?.data?.compile?.sld;
    if (sld) {
        try {
            const parsed = JSON.parse(sld);
            if (parsed?.kind === "zxbasic"
                && Number.isInteger(parsed.anchor)
                && Array.isArray(parsed.lines)) {
                debug = parsed;
            }
        } catch (e) {
            console.warn("[zxbasic] unparseable debug map ignored", e);
        }
    }

    // noinspection JSDeprecatedSymbols
    return {
        tap: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
        debug,
    };
}
