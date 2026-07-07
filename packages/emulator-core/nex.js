// makeNEX — port of ZXNextPlatform.makeNEX from the retrogamecoders/8bitworkshop
// fork (src/platform/zxnext.ts), GPLv3. Wraps a raw memory image based at `org`
// (default $8000) into a minimal .NEX V1.2 container that NextZXOS .nexload runs.
//
// Verbatim logic, TypeScript annotations removed. Kept standalone (no imports) so
// the local harness can build a .nex in-browser exactly as the IDE does.

export function makeNEX(bin, org = 0x8000) {
  const BANK = 0x4000;
  if (org < 0x8000 || org >= 0xC000)
    throw new Error(`zxnext: org $${org.toString(16)} unsupported (need $8000-$BFFF)`);
  if (org + bin.length > 0x10000)
    throw new Error(`zxnext: program overruns $FFFF (org $${org.toString(16)}, ${bin.length} bytes)`);

  const bank2 = new Uint8Array(BANK); // $8000-$BFFF
  const bank0 = new Uint8Array(BANK); // $C000-$FFFF (entry bank 0)
  let usesBank0 = false;
  for (let i = 0; i < bin.length; i++) {
    const addr = org + i;
    if (addr < 0xC000) bank2[addr - 0x8000] = bin[i];
    else { bank0[addr - 0xC000] = bin[i]; usesBank0 = true; }
  }

  const banks = [[2, bank2]];
  if (usesBank0) banks.push([0, bank0]);

  const header = new Uint8Array(512);
  const w16 = (off, v) => { header[off] = v & 0xFF; header[off + 1] = v >> 8; };
  header.set([0x4E, 0x65, 0x78, 0x74], 0);           // "Next"
  header.set([0x56, 0x31, 0x2E, 0x32], 4);           // "V1.2"
  header[8] = 0;                                      // RAM required: 768K
  header[9] = banks.length;                           // banks to load
  header[10] = 0;                                     // no loading screen
  header[11] = 0;                                     // border black
  w16(12, 0x7FFE);                                    // SP (top of bank 5 slot)
  w16(14, org);                                       // PC = entry point
  w16(16, 0);                                         // numfiles
  for (const [id] of banks) header[18 + id] = 1;      // bank-present flags
  header[139] = 0;                                    // entry bank at $C000

  const out = new Uint8Array(512 + banks.length * BANK);
  out.set(header, 0);
  // Write bank data in canonical order (5,2,0,1,3,4,6,7,...).
  const ORDER = [5, 2, 0, 1, 3, 4, 6, 7];
  let off = 512;
  for (const id of ORDER) {
    const b = banks.find(x => x[0] === id);
    if (b) { out.set(b[1], off); off += BANK; }
  }
  return out;
}

// A 7-byte Z80 program at $8000 that sets the border red and halts-loops.
// No assembler required — proves the emulator + .nex load path end to end.
//   3E 02      LD A,2        ; red
//   D3 FE      OUT ($FE),A   ; border
//   18 FE      JR $          ; loop forever
export function demoRedBorderNex() {
  const prog = new Uint8Array([0x3E, 0x02, 0xD3, 0xFE, 0x18, 0xFE]);
  return makeNEX(prog, 0x8000);
}
