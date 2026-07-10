import axios from "axios";
import {getZXBasicTap} from "./zxbasicCompile";

jest.mock("axios");
jest.mock("../../constants", () => ({
    __esModule: true,
    default: {graphQlEndpoint: "http://test/v1/graphql"},
}));
jest.mock("../../auth", () => ({
    getAuthToken: () => "jwt",
    isExpired: () => false,
    refreshToken: () => Promise.resolve("jwt"),
}));

// --- Half 1: getZXBasicTap surfaces a compile error as build-error items -----

describe("getZXBasicTap error surfacing", () => {
    afterEach(() => jest.clearAllMocks());

    test("throws error items when Hasura returns GraphQL errors (HTTP 200)", async () => {
        axios.post.mockResolvedValue({
            data: {
                errors: [{message: "program.bas:3: error: Syntax error. Unexpected token '7'"}],
            },
        });

        await expect(getZXBasicTap("bad code", null)).rejects.toEqual([
            {type: "err", text: "program.bas:3: error: Syntax error. Unexpected token '7'"},
        ]);
    });

    test("throws error items when Hasura returns a non-2xx (axios rejects)", async () => {
        const err = new Error("Request failed with status code 400");
        err.response = {data: {message: "program.bas:3: error: boom"}};
        axios.post.mockRejectedValue(err);

        await expect(getZXBasicTap("bad code", null)).rejects.toEqual([
            {type: "err", text: "program.bas:3: error: boom"},
        ]);
    });

    test("throws when a non-2xx carries the message inside errors[]", async () => {
        const err = new Error("Request failed with status code 400");
        err.response = {data: {errors: [{message: "program.bas:9: error: nope"}]}};
        axios.post.mockRejectedValue(err);

        await expect(getZXBasicTap("bad code", null)).rejects.toEqual([
            {type: "err", text: "program.bas:9: error: nope"},
        ]);
    });

    test("throws 'no output' when a success response carries no TAP", async () => {
        axios.post.mockResolvedValue({data: {data: {compile: null}}});

        await expect(getZXBasicTap("code", null)).rejects.toEqual([
            {type: "err", text: "Compilation produced no output."},
        ]);
    });

    test("normalises an unexpected (non-array) error into build-error items", async () => {
        // A success envelope whose base64 is garbage makes atob throw deep in
        // the function; that must still surface as an array, never silence.
        axios.post.mockResolvedValue({data: {data: {compile: {base64_encoded: "!!!!"}}}});

        await expect(getZXBasicTap("code", null)).rejects.toEqual(
            expect.arrayContaining([expect.objectContaining({type: "err"})]),
        );
    });

    test("returns bytes on success, with a null debug map when absent", async () => {
        // base64 of the two bytes [0x13, 0x00]
        const b64 = Buffer.from([0x13, 0x00]).toString("base64");
        axios.post.mockResolvedValue({data: {data: {compile: {base64_encoded: b64}}}});

        const result = await getZXBasicTap("good code", null);
        expect(Array.from(result.tap)).toEqual([0x13, 0x00]);
        expect(result.debug).toBeNull();
    });

    test("parses the service's debugger line map from sld", async () => {
        const b64 = Buffer.from([0x13, 0x00]).toString("base64");
        const sld = JSON.stringify({kind: "zxbasic", anchor: 0x9333, lines: [2, 5]});
        axios.post.mockResolvedValue({data: {data: {compile: {base64_encoded: b64, sld}}}});

        const result = await getZXBasicTap("good code", null);
        expect(result.debug).toEqual({kind: "zxbasic", anchor: 0x9333, lines: [2, 5]});
    });

    test("a malformed debug map is ignored, never fatal", async () => {
        const b64 = Buffer.from([0x13, 0x00]).toString("base64");
        axios.post.mockResolvedValue({data: {data: {compile: {base64_encoded: b64, sld: "{nope"}}}});

        const result = await getZXBasicTap("good code", null);
        expect(Array.from(result.tap)).toEqual([0x13, 0x00]);
        expect(result.debug).toBeNull();
    });
});
