import {
    FOUR_BIT_TRANSPARENT,
    PLUS3DOS_HEADER_SIZE,
    SPRITE_BYTES,
    TRANSPARENT_INDEX,
    expandFourBit,
    packFourBit,
    base64ByteLength,
    base64ToBytes,
    bytesToBase64,
    blankSpriteBase64,
    blankTileBase64,
    isTileFileName,
    defaultSpritePalette,
    isEditableSpriteContent,
    isSpriteFileName,
    joinSpriteFile,
    splitSpriteFile,
    spritePatternCount,
} from "./spr";

// A minimal valid +3DOS CODE header for the given data length.
function plus3DosFile(dataLength, fill = 0) {
    const bytes = new Uint8Array(PLUS3DOS_HEADER_SIZE + dataLength).fill(fill);
    const sig = "PLUS3DOS\x1a";
    for (let i = 0; i < sig.length; i++) {
        bytes[i] = sig.charCodeAt(i);
    }
    bytes[9] = 1; // issue
    bytes[10] = 0; // version
    const total = bytes.length;
    bytes[11] = total & 0xff;
    bytes[12] = (total >> 8) & 0xff;
    bytes[13] = 0;
    bytes[14] = 0;
    bytes[15] = 3; // CODE
    bytes[16] = dataLength & 0xff;
    bytes[17] = (dataLength >> 8) & 0xff;
    let sum = 0;
    for (let i = 0; i < PLUS3DOS_HEADER_SIZE - 1; i++) {
        sum += bytes[i];
    }
    bytes[PLUS3DOS_HEADER_SIZE - 1] = sum & 0xff;
    return bytes;
}

describe("isSpriteFileName", () => {
    test("matches the .spr extension case-insensitively", () => {
        expect(isSpriteFileName("tiles.spr")).toBe(true);
        expect(isSpriteFileName("SHIP.SPR")).toBe(true);
        expect(isSpriteFileName("tiles.spr.bak")).toBe(false);
        expect(isSpriteFileName("sprites")).toBe(false);
        expect(isSpriteFileName("")).toBe(false);
        expect(isSpriteFileName(null)).toBe(false);
    });
});

describe("base64 round trip", () => {
    test("bytes survive encode/decode unchanged", () => {
        const bytes = new Uint8Array(SPRITE_BYTES);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = i & 0xff;
        }
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });

    test("byte length is computed without decoding", () => {
        for (const size of [1, 2, 3, 255, 256, 512]) {
            const b64 = bytesToBase64(new Uint8Array(size));
            expect(base64ByteLength(b64)).toBe(size);
        }
        expect(base64ByteLength("")).toBe(0);
        expect(base64ByteLength(null)).toBe(0);
    });
});

describe("sprite content shape", () => {
    test("whole 256-byte patterns are editable", () => {
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(256)))).toBe(true);
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(1024)))).toBe(true);
    });

    test("whole 4-bit patterns are editable too", () => {
        // A lone 4-bit pattern (128 bytes) or an odd count of them.
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(128)))).toBe(true);
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(384)))).toBe(true);
    });

    test("empty or partial patterns are not", () => {
        expect(isEditableSpriteContent("")).toBe(false);
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(100)))).toBe(false);
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(300)))).toBe(false);
    });

    test("pattern count", () => {
        expect(spritePatternCount(256)).toBe(1);
        expect(spritePatternCount(1024)).toBe(4);
    });

    test("a new sprite file is one all-transparent pattern", () => {
        const bytes = base64ToBytes(blankSpriteBase64());
        expect(bytes.length).toBe(SPRITE_BYTES);
        expect(bytes.every((b) => b === TRANSPARENT_INDEX)).toBe(true);
    });
});

describe("tile files", () => {
    test("isTileFileName matches .til and .tile", () => {
        expect(isTileFileName("bank.til")).toBe(true);
        expect(isTileFileName("BANK.TILE")).toBe(true);
        expect(isTileFileName("bank.spr")).toBe(false);
    });

    test("tile content counts in 32-byte units", () => {
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(32)), true)).toBe(true);
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(96)), true)).toBe(true);
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(48)), true)).toBe(false);
        // .spr keeps the coarser 128-byte rule.
        expect(isEditableSpriteContent(bytesToBase64(new Uint8Array(96)), false)).toBe(false);
    });

    test("a new tile file is one blank 4-bit tile", () => {
        const bytes = base64ToBytes(blankTileBase64());
        expect(bytes.length).toBe(32);
        expect(bytes.every((b) => b === 0x33)).toBe(true);
    });
});

describe("4-bit packing", () => {
    test("expand and pack round trip", () => {
        const packed = new Uint8Array([0x12, 0xaf, 0x03]);
        const pixels = expandFourBit(packed);
        expect(Array.from(pixels)).toEqual([1, 2, 0xa, 0xf, 0, 3]);
        expect(packFourBit(pixels)).toEqual(packed);
    });

    test("pack masks out-of-range values to nibbles", () => {
        expect(Array.from(packFourBit(new Uint8Array([0xe3, 0x1f])))).toEqual([0x3f]);
    });

    test("the transparent nibble is the low bits of $E3", () => {
        expect(FOUR_BIT_TRANSPARENT).toBe(3);
    });
});

describe("+3DOS headers", () => {
    test("a headered file with whole patterns is editable", () => {
        expect(isEditableSpriteContent(bytesToBase64(plus3DosFile(256)))).toBe(true);
        expect(isEditableSpriteContent(bytesToBase64(plus3DosFile(1024)))).toBe(true);
    });

    test("header-sized data without the signature reads as bare 4-bit patterns", () => {
        // 384 bytes without PLUS3DOS is not headered — but it IS three whole
        // 4-bit patterns, so it stays editable; split treats it as bare data.
        const junk = new Uint8Array(PLUS3DOS_HEADER_SIZE + 256).fill(7);
        expect(isEditableSpriteContent(bytesToBase64(junk))).toBe(true);
        expect(splitSpriteFile(junk).header).toBe(null);
    });

    test("a headered file with partial patterns is not", () => {
        expect(isEditableSpriteContent(bytesToBase64(plus3DosFile(100)))).toBe(false);
    });

    test("split separates header from pattern data", () => {
        const file = plus3DosFile(512, 5);
        const { header, data } = splitSpriteFile(file);
        expect(header.length).toBe(PLUS3DOS_HEADER_SIZE);
        expect(data.length).toBe(512);
        expect(data.every((b) => b === 5)).toBe(true);
    });

    test("split leaves bare files alone", () => {
        const bare = new Uint8Array(256).fill(9);
        const { header, data } = splitSpriteFile(bare);
        expect(header).toBe(null);
        expect(data).toEqual(bare);
    });

    test("join round-trips a file unchanged", () => {
        const file = plus3DosFile(512, 5);
        const { header, data } = splitSpriteFile(file);
        expect(joinSpriteFile(header, data)).toEqual(file);
    });

    test("join refreshes lengths and checksum when patterns grow", () => {
        const { header } = splitSpriteFile(plus3DosFile(256));
        const grown = joinSpriteFile(header, new Uint8Array(512));
        expect(grown.length).toBe(PLUS3DOS_HEADER_SIZE + 512);
        // Total-length dword and CODE data length word.
        expect(grown[11] | (grown[12] << 8)).toBe(PLUS3DOS_HEADER_SIZE + 512);
        expect(grown[16] | (grown[17] << 8)).toBe(512);
        // Checksum re-covers the updated fields.
        let sum = 0;
        for (let i = 0; i < PLUS3DOS_HEADER_SIZE - 1; i++) {
            sum += grown[i];
        }
        expect(grown[PLUS3DOS_HEADER_SIZE - 1]).toBe(sum & 0xff);
    });

    test("join without a header returns the data as-is", () => {
        const data = new Uint8Array(256).fill(3);
        expect(joinSpriteFile(null, data)).toEqual(data);
    });
});

describe("defaultSpritePalette", () => {
    const palette = defaultSpritePalette();

    test("has 256 CSS colours", () => {
        expect(palette.length).toBe(256);
        for (const colour of palette) {
            expect(colour).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    test("RGB332 corners", () => {
        expect(palette[0x00]).toBe("#000000");
        // All bits set: white.
        expect(palette[0xff]).toBe("#ffffff");
        // Red only (111 00 000).
        expect(palette[0xe0]).toBe("#ff0000");
        // Green only (000 111 00).
        expect(palette[0x1c]).toBe("#00ff00");
        // Blue only (000 000 11): 9-bit blue 111 -> full blue.
        expect(palette[0x03]).toBe("#0000ff");
    });

    test("blue LSB is the OR of the two blue bits", () => {
        // BB=01 -> 9-bit blue 011 (3/7); BB=10 -> 101 (5/7).
        expect(palette[0x01]).toBe(`#0000${Math.round((3 * 255) / 7).toString(16).padStart(2, "0")}`);
        expect(palette[0x02]).toBe(`#0000${Math.round((5 * 255) / 7).toString(16).padStart(2, "0")}`);
    });
});
