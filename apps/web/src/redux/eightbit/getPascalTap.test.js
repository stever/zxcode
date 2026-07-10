import axios from "axios";
import {getPascalTap} from "./pascalCompile";

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

describe("getPascalTap error surfacing", () => {
    afterEach(() => jest.clearAllMocks());

    test("throws error items when Hasura returns GraphQL errors (HTTP 200)", async () => {
        axios.post.mockResolvedValue({
            data: {
                errors: [{message: "*** Error at 3,11: Expected \")\", but got \"end\""}],
            },
        });

        await expect(getPascalTap("bad code", "48", null)).rejects.toEqual([
            {type: "err", text: "*** Error at 3,11: Expected \")\", but got \"end\""},
        ]);
    });

    test("throws error items when Hasura returns a non-2xx (axios rejects)", async () => {
        const err = new Error("Request failed with status code 400");
        err.response = {data: {message: "*** Error at 1,1: boom"}};
        axios.post.mockRejectedValue(err);

        await expect(getPascalTap("bad code", "48", null)).rejects.toEqual([
            {type: "err", text: "*** Error at 1,1: boom"},
        ]);
    });

    test("throws 'no output' when a success response carries no bytes", async () => {
        axios.post.mockResolvedValue({data: {data: {compilePascal: null}}});

        await expect(getPascalTap("code", "48", null)).rejects.toEqual([
            {type: "err", text: "Compilation produced no output."},
        ]);
    });

    test("normalises an unexpected (non-array) error into build-error items", async () => {
        // A success envelope whose base64 is garbage makes atob throw deep in
        // the function; that must still surface as an array, never silence.
        axios.post.mockResolvedValue({data: {data: {compilePascal: {base64_encoded: "!!!!"}}}});

        await expect(getPascalTap("code", "48", null)).rejects.toEqual(
            expect.arrayContaining([expect.objectContaining({type: "err"})]),
        );
    });

    test("returns bytes and passes the machine variable through", async () => {
        const b64 = Buffer.from("\x13\x00\x00run.bas").toString("base64");
        axios.post.mockResolvedValue({data: {data: {compilePascal: {base64_encoded: b64}}}});

        const result = await getPascalTap("good code", "next", null);
        expect(result.tap.length).toBeGreaterThan(0);
        expect(result.debug).toBeNull();
        const [, body] = axios.post.mock.calls[0];
        expect(body.variables).toEqual({code: "good code", machine: "next", files: []});
    });

    test("parses the service's debugger line map from sld", async () => {
        const b64 = Buffer.from("tap").toString("base64");
        const sld = JSON.stringify({kind: "pasta80", entries: [[5, 0x8100], [6, 0x8108]]});
        axios.post.mockResolvedValue({data: {data: {compilePascal: {base64_encoded: b64, sld}}}});

        const result = await getPascalTap("good code", "48", null);
        expect(result.debug).toEqual({kind: "pasta80", entries: [[5, 0x8100], [6, 0x8108]]});
    });

    test("a malformed debug map is ignored, never fatal", async () => {
        const b64 = Buffer.from("tap").toString("base64");
        axios.post.mockResolvedValue({data: {data: {compilePascal: {base64_encoded: b64, sld: "{nope"}}}});

        const result = await getPascalTap("good code", "48", null);
        expect(result.tap.length).toBeGreaterThan(0);
        expect(result.debug).toBeNull();
    });

    test("passes additional project files through", async () => {
        const b64 = Buffer.from("tap").toString("base64");
        axios.post.mockResolvedValue({data: {data: {compilePascal: {base64_encoded: b64}}}});

        const files = [{name: "part.inc", content: "procedure P; begin end;", is_binary: false}];
        await getPascalTap("good code", "48", null, files);
        const [, body] = axios.post.mock.calls[0];
        expect(body.variables.files).toEqual(files);
    });

    test("numeric machine values are normalised to strings", async () => {
        const b64 = Buffer.from("tap").toString("base64");
        axios.post.mockResolvedValue({data: {data: {compilePascal: {base64_encoded: b64}}}});

        await getPascalTap("good code", 128, null);
        const [, body] = axios.post.mock.calls[0];
        expect(body.variables.machine).toBe("128");
    });
});
