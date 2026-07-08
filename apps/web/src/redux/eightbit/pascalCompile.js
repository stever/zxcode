import axios from "axios";
import gql from "graphql-tag";
import {print} from "graphql";
import Constants from "../../constants";
import {getAuthToken, isExpired, refreshToken} from "../../auth";
import {extractCompilerError} from "./zxbasicCompile";

const COMPILE_MUTATION = gql`
    mutation ($code: String!, $machine: String) {
        compilePascal(code: $code, machine: $machine) {
            base64_encoded
        }
    }
`;

// Compile via the Pasta80 service and return the TAP bytes. The machine
// ('48' | '128' | 'next') selects the codegen target — each links a
// different runtime, so Next-only features exist only there. On failure it
// throws an array of build-error items ({type: 'err', text}) - the same
// shape the other compilers reject with - so the saga surfaces them as
// build-error toasts rather than the full-page error banner.
//
// It is guaranteed to only ever throw an array of items: any unexpected error
// (token refresh, malformed payload, ...) is normalised too, so a failure can
// never surface as silence.
export async function getPascalTap(code, machine, userId) {
    console.log("[pasta80] compile requested", {codeLength: code?.length, machine, userId});
    try {
        const tap = await compile(code, machine, userId);
        console.log("[pasta80] compile succeeded", {bytes: tap.length});
        return tap;
    } catch (e) {
        // Re-throw our own build-error arrays unchanged; wrap anything else.
        if (Array.isArray(e)) {
            console.error("[pasta80] compile failed", e);
            throw e;
        }
        console.error("[pasta80] compile failed (unexpected)", e);
        throw [{type: "err", text: e?.message || String(e) || "Compilation failed."}];
    }
}

async function compile(code, machine, userId) {
    const variables = {code, machine: String(machine)};

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
        console.error("[pasta80] transport error", e?.response?.status, e?.response?.data || e);
        throw [{type: "err", text: extractCompilerError(undefined, e)}];
    }

    if (envelope?.errors?.length > 0) {
        console.error("[pasta80] GraphQL errors in envelope", envelope.errors);
        throw [{type: "err", text: extractCompilerError(envelope)}];
    }

    // noinspection JSUnresolvedVariable
    const base64 = envelope?.data?.compilePascal?.base64_encoded;
    if (!base64) {
        throw [{type: "err", text: "Compilation produced no output."}];
    }

    // noinspection JSDeprecatedSymbols
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
