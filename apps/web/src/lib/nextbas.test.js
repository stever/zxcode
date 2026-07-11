/**
 * @jest-environment node
 *
 * txt2bas needs TextEncoder, which the default jsdom environment lacks.
 */
import getBasicProgram from "./nextbas";

const PLUS3DOS_SIG = [0x50, 0x4c, 0x55, 0x53, 0x33, 0x44, 0x4f, 0x53];

describe("getBasicProgram", () => {
  const plain = '10 PRINT "HI"\n20 GO TO 10';

  it("emits PLUS3DOS bytes for the Next", () => {
    const out = getBasicProgram(plain, "next");
    expect(Array.from(out.slice(0, 8))).toEqual(PLUS3DOS_SIG);
  });

  it("emits a program TAP for classic machines, autostart in the header", () => {
    const out = getBasicProgram(plain, 48);
    // TAP program header: [len][flag 0x00][type 0x00 = program]...
    expect(out[2]).toBe(0x00);
    expect(out[3]).toBe(0x00);
    // param1 (autostart) sits at data offset 14-15 = tap offset 16-17;
    // ensureAutostart injects the first line when the source sets none.
    expect(out[16] | (out[17] << 8)).toBe(10);
  });

  it("respects an explicit #autostart directive", () => {
    const out = getBasicProgram(`#autostart 20\n${plain}`, 48);
    expect(out[16] | (out[17] << 8)).toBe(20);
  });

  it("rejects Next-only keywords on the 48K with a named line error", () => {
    expect(() => getBasicProgram('10 LAYER 2,1\n20 PRINT "X"', 48)).toThrow();
    try {
      getBasicProgram('10 LAYER 2,1\n20 PRINT "X"', 48);
    } catch (items) {
      expect(Array.isArray(items)).toBe(true);
      expect(items[0].type).toBe("err");
      expect(items[0].text).toContain("line 10");
      expect(items[0].text).toContain("LAYER");
    }
  });

  it("draws the 128K line at SPECTRUM/PLAY", () => {
    // PLAY (0xA4) belongs to the 128K editor: rejected on 48, allowed on 128.
    expect(() => getBasicProgram('10 PLAY "abc"', 48)).toThrow();
    expect(() => getBasicProgram('10 PLAY "abc"', 128)).not.toThrow();
    // A genuine Next extension stays rejected on both.
    expect(() => getBasicProgram("10 LAYER 2,1", 128)).toThrow();
  });

  it("allows Next keywords when targeting the Next", () => {
    expect(() => getBasicProgram("10 LAYER 2,1", "next")).not.toThrow();
  });

  it("accepts lowercase keywords like zmakebas did", () => {
    // txt2bas keywords are case-insensitive; only lowercase SPACED
    // multi-word forms ("go to") fail — the run-together forms work.
    expect(() => getBasicProgram('10 border 2: print "x": goto 10', 48))
        .not.toThrow();
  });

  it("wraps tokeniser errors in the {type, text} item shape", () => {
    try {
      getBasicProgram("10 go to 10", 48);
      throw new Error("expected a compile failure");
    } catch (items) {
      expect(Array.isArray(items)).toBe(true);
      expect(items[0].type).toBe("err");
    }
  });
});
