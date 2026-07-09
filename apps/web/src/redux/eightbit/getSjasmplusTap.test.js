import axios from "axios";
import {getSjasmplusTap} from "./sjasmplusCompile";

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

describe("getSjasmplusTap error surfacing", () => {
    afterEach(() => jest.clearAllMocks());

    test("throws error items when Hasura returns GraphQL errors (HTTP 200)", async () => {
        axios.post.mockResolvedValue({
            data: {
                errors: [{message: "program.asm(2): error: Illegal instruction:     ld a,,2"}],
            },
        });

        await expect(getSjasmplusTap("bad code", null)).rejects.toEqual([
            {type: "err", text: "program.asm(2): error: Illegal instruction:     ld a,,2"},
        ]);
    });

    test("throws error items when Hasura returns a non-2xx (axios rejects)", async () => {
        const err = new Error("Request failed with status code 400");
        err.response = {data: {message: "program.asm(3): error: boom"}};
        axios.post.mockRejectedValue(err);

        await expect(getSjasmplusTap("bad code", null)).rejects.toEqual([
            {type: "err", text: "program.asm(3): error: boom"},
        ]);
    });

    test("throws when a non-2xx carries the message inside errors[]", async () => {
        const err = new Error("Request failed with status code 400");
        err.response = {data: {errors: [{message: "program.asm(9): error: nope"}]}};
        axios.post.mockRejectedValue(err);

        await expect(getSjasmplusTap("bad code", null)).rejects.toEqual([
            {type: "err", text: "program.asm(9): error: nope"},
        ]);
    });

    test("throws 'no output' when a success response carries no bytes", async () => {
        axios.post.mockResolvedValue({data: {data: {compileSjasmplus: null}}});

        await expect(getSjasmplusTap("code", null)).rejects.toEqual([
            {type: "err", text: "Compilation produced no output."},
        ]);
    });

    test("normalises an unexpected (non-array) error into build-error items", async () => {
        // A success envelope whose base64 is garbage makes atob throw deep in
        // the function; that must still surface as an array, never silence.
        axios.post.mockResolvedValue({data: {data: {compileSjasmplus: {base64_encoded: "!!!!"}}}});

        await expect(getSjasmplusTap("code", null)).rejects.toEqual(
            expect.arrayContaining([expect.objectContaining({type: "err"})]),
        );
    });

    test("returns bytes and sld on success (NEX signature preserved)", async () => {
        const b64 = Buffer.from("NextV1.2").toString("base64");
        axios.post.mockResolvedValue({data: {data: {compileSjasmplus: {
            base64_encoded: b64,
            sld: "|SLD.data.version|1\n",
        }}}});

        const {tap, sld} = await getSjasmplusTap("good code", null);
        expect(String.fromCharCode(...tap.slice(0, 4))).toBe("Next");
        expect(sld).toBe("|SLD.data.version|1\n");
    });

    test("sld is null when the service returns none", async () => {
        const b64 = Buffer.from("NextV1.2").toString("base64");
        axios.post.mockResolvedValue({data: {data: {compileSjasmplus: {base64_encoded: b64}}}});

        const {sld} = await getSjasmplusTap("good code", null);
        expect(sld).toBeNull();
    });
});
