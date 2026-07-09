import axios from "axios";
import gql from "graphql-tag";
import {print} from "graphql";
import Constants from "../../constants";
import {getAuthToken, isExpired, refreshToken} from "../../auth";
import {extractCompilerError} from "./zxbasicCompile";

const COMPILE_MUTATION = gql`
    mutation ($code: String!, $files: [ProjectFileInput!]) {
        compileC(code: $code, files: $files) {
            base64_encoded
        }
    }
`;

// Compile C via the z88dk service and return the TAP bytes. On failure it
// throws an array of build-error items ({type: 'err', text}) - the same shape
// the other in-browser compilers reject with - so the saga surfaces them as
// build-error toasts rather than the full-page error banner that gqlFetch
// would trigger.
//
// It is guaranteed to only ever throw an array of items: any unexpected error
// (token refresh, malformed payload, ...) is normalised too, so a failure can
// never surface as silence.
export async function getZ88dkTap(code, userId, files = []) {
    console.log("[z88dk] compile requested", {codeLength: code?.length, userId, files: files.length});
    try {
        const tap = await compile(code, userId, files);
        console.log("[z88dk] compile succeeded", {tapBytes: tap.length});
        return tap;
    } catch (e) {
        // Re-throw our own build-error arrays unchanged; wrap anything else.
        if (Array.isArray(e)) {
            console.error("[z88dk] compile failed", e);
            throw e;
        }
        console.error("[z88dk] compile failed (unexpected)", e);
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
        console.error("[z88dk] transport error", e?.response?.status, e?.response?.data || e);
        throw [{type: "err", text: extractCompilerError(undefined, e)}];
    }

    if (envelope?.errors?.length > 0) {
        console.error("[z88dk] GraphQL errors in envelope", envelope.errors);
        throw [{type: "err", text: extractCompilerError(envelope)}];
    }

    // noinspection JSUnresolvedVariable
    const base64 = envelope?.data?.compileC?.base64_encoded;
    if (!base64) {
        throw [{type: "err", text: "Compilation produced no output."}];
    }

    // noinspection JSDeprecatedSymbols
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
