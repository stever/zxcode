import axios from "axios";
import {getForthTap} from "./forthCompile";

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

describe("getForthTap error surfacing", () => {
    afterEach(() => jest.clearAllMocks());

    test("throws error items when Hasura returns GraphQL errors (HTTP 200)", async () => {
        axios.post.mockResolvedValue({
            data: {
                errors: [{message: "Program too large: the embedded source..."}],
            },
        });

        await expect(getForthTap("big code", null)).rejects.toEqual([
            {type: "err", text: "Program too large: the embedded source..."},
        ]);
    });

    test("throws error items when Hasura returns a non-2xx (axios rejects)", async () => {
        const err = new Error("Request failed with status code 400");
        err.response = {data: {message: "Compilation failed"}};
        axios.post.mockRejectedValue(err);

        await expect(getForthTap("code", null)).rejects.toEqual([
            {type: "err", text: "Compilation failed"},
        ]);
    });

    test("throws 'no output' when a success response carries no bytes", async () => {
        axios.post.mockResolvedValue({data: {data: {compileForth: null}}});

        await expect(getForthTap("code", null)).rejects.toEqual([
            {type: "err", text: "Compilation produced no output."},
        ]);
    });

    test("normalises an unexpected (non-array) error into build-error items", async () => {
        // A success envelope whose base64 is garbage makes atob throw deep in
        // the function; that must still surface as an array, never silence.
        axios.post.mockResolvedValue({data: {data: {compileForth: {base64_encoded: "!!!!"}}}});

        await expect(getForthTap("code", null)).rejects.toEqual(
            expect.arrayContaining([expect.objectContaining({type: "err"})]),
        );
    });

    test("returns bytes; the mutation carries only the code", async () => {
        const b64 = Buffer.from("\x13\x00\x00zenv").toString("base64");
        axios.post.mockResolvedValue({data: {data: {compileForth: {base64_encoded: b64}}}});

        const tap = await getForthTap(": DEMO 5 . ;\nDEMO", null);
        expect(tap.length).toBeGreaterThan(0);
        const [, body] = axios.post.mock.calls[0];
        expect(body.variables).toEqual({code: ": DEMO 5 . ;\nDEMO"});
    });
});
