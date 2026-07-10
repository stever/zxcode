import axios from "axios";
import {getZ88dkTap} from "./z88dkCompile";

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

describe("getZ88dkTap error surfacing", () => {
    afterEach(() => jest.clearAllMocks());

    test("throws error items when Hasura returns GraphQL errors (HTTP 200)", async () => {
        axios.post.mockResolvedValue({
            data: {
                errors: [{message: "program.c:2: file 'spectrum.h' not found"}],
            },
        });

        await expect(getZ88dkTap("bad code", null)).rejects.toEqual([
            {type: "err", text: "program.c:2: file 'spectrum.h' not found"},
        ]);
    });

    test("throws error items when Hasura returns a non-2xx (axios rejects)", async () => {
        const err = new Error("Request failed with status code 400");
        err.response = {data: {message: "program.c:3: error: boom"}};
        axios.post.mockRejectedValue(err);

        await expect(getZ88dkTap("bad code", null)).rejects.toEqual([
            {type: "err", text: "program.c:3: error: boom"},
        ]);
    });

    test("throws when a non-2xx carries the message inside errors[]", async () => {
        const err = new Error("Request failed with status code 400");
        err.response = {data: {errors: [{message: "program.c:9: error: nope"}]}};
        axios.post.mockRejectedValue(err);

        await expect(getZ88dkTap("bad code", null)).rejects.toEqual([
            {type: "err", text: "program.c:9: error: nope"},
        ]);
    });

    test("throws 'no output' when a success response carries no TAP", async () => {
        axios.post.mockResolvedValue({data: {data: {compileC: null}}});

        await expect(getZ88dkTap("code", null)).rejects.toEqual([
            {type: "err", text: "Compilation produced no output."},
        ]);
    });

    test("normalises an unexpected (non-array) error into build-error items", async () => {
        // A success envelope whose base64 is garbage makes atob throw deep in
        // the function; that must still surface as an array, never silence.
        axios.post.mockResolvedValue({data: {data: {compileC: {base64_encoded: "!!!!"}}}});

        await expect(getZ88dkTap("code", null)).rejects.toEqual(
            expect.arrayContaining([expect.objectContaining({type: "err"})]),
        );
    });

    test("returns bytes on success, with a null debug map when absent", async () => {
        // base64 of the two bytes [0x13, 0x00]
        const b64 = Buffer.from([0x13, 0x00]).toString("base64");
        axios.post.mockResolvedValue({data: {data: {compileC: {base64_encoded: b64}}}});

        const result = await getZ88dkTap("good code", null);
        expect(Array.from(result.tap)).toEqual([0x13, 0x00]);
        expect(result.debug).toBeNull();
    });

    test("parses the service's debugger line map from sld", async () => {
        const b64 = Buffer.from([0x13, 0x00]).toString("base64");
        const sld = JSON.stringify({kind: "z88dk", files: {"": [[5, 0x9364]]}});
        axios.post.mockResolvedValue({data: {data: {compileC: {base64_encoded: b64, sld}}}});

        const result = await getZ88dkTap("good code", null);
        expect(result.debug).toEqual({kind: "z88dk", files: {"": [[5, 0x9364]]}});
    });

    test("a malformed debug map is ignored, never fatal", async () => {
        const b64 = Buffer.from([0x13, 0x00]).toString("base64");
        axios.post.mockResolvedValue({data: {data: {compileC: {base64_encoded: b64, sld: "{nope"}}}});

        const result = await getZ88dkTap("good code", null);
        expect(Array.from(result.tap)).toEqual([0x13, 0x00]);
        expect(result.debug).toBeNull();
    });
});
