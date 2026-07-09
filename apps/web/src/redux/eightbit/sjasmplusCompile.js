import axios from "axios";
import gql from "graphql-tag";
import {print} from "graphql";
import Constants from "../../constants";
import {getAuthToken, isExpired, refreshToken} from "../../auth";
import {extractCompilerError} from "./zxbasicCompile";

const COMPILE_MUTATION = gql`
    mutation ($code: String!, $files: [ProjectFileInput!]) {
        compileSjasmplus(code: $code, files: $files) {
            base64_encoded
            sld
        }
    }
`;

// Assemble via the sjasmplus service and return {tap, sld}: the output bytes
// — a TAP or, when the source uses SAVENEX, a NEX image (the emulator sniffs
// the 'Next' signature at load time) — plus the SLD source-map text for the
// debugger (null when the service produced none). On failure it throws an
// array of build-error items ({type: 'err', text}) - the same shape the
// other compilers reject with - so the saga surfaces them as build-error
// toasts rather than the full-page error banner.
//
// It is guaranteed to only ever throw an array of items: any unexpected error
// (token refresh, malformed payload, ...) is normalised too, so a failure can
// never surface as silence.
export async function getSjasmplusTap(code, userId, files = []) {
    console.log("[sjasmplus] compile requested", {codeLength: code?.length, userId, files: files.length});
    try {
        const result = await compile(code, userId, files);
        console.log("[sjasmplus] compile succeeded",
            {bytes: result.tap.length, sldBytes: result.sld?.length || 0});
        return result;
    } catch (e) {
        // Re-throw our own build-error arrays unchanged; wrap anything else.
        if (Array.isArray(e)) {
            console.error("[sjasmplus] compile failed", e);
            throw e;
        }
        console.error("[sjasmplus] compile failed (unexpected)", e);
        throw [{type: "err", text: e?.message || String(e) || "Compilation failed."}];
    }
}

async function compile(code, userId, files) {
    const variables = {code, files};

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
        console.error("[sjasmplus] transport error", e?.response?.status, e?.response?.data || e);
        throw [{type: "err", text: extractCompilerError(undefined, e)}];
    }

    if (envelope?.errors?.length > 0) {
        console.error("[sjasmplus] GraphQL errors in envelope", envelope.errors);
        throw [{type: "err", text: extractCompilerError(envelope)}];
    }

    // noinspection JSUnresolvedVariable
    const base64 = envelope?.data?.compileSjasmplus?.base64_encoded;
    if (!base64) {
        throw [{type: "err", text: "Compilation produced no output."}];
    }

    return {
        // noinspection JSDeprecatedSymbols
        tap: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
        sld: envelope?.data?.compileSjasmplus?.sld || null,
    };
}
