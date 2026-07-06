// TAP -> Spectrum Next translation. The Next cannot tape-load in zx_go yet
// (two upstream core defects, see plan_zxgo_migration.md), but NextZXOS has
// two fully working program-delivery routes: an autoexec NextBASIC file
// (zxRunBas) and a .nex via the OS's own .nexload (zxRunNex). This module
// turns the compilers' TAP output into whichever of those fits:
//
// - a TAP whose first meaningful entry is a BASIC Program block becomes a
//   PLUS3DOS-headered program (Sinclair BASIC is a NextBASIC subset);
// - a TAP carrying a machine-code block loading at $8000-$BFFF becomes a
//   minimal .nex with PC at the load address (the 8bitworkshop convention
//   the asm toolchain follows).
//
// makeNEX is ported from the retrogamecoders/8bitworkshop fork's
// ZXNextPlatform.makeNEX (GPLv3) — canonical copy: packages/emulator-core/nex.js.

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

// Parse a TAP into [{type, name, param1, param2, data}] entries by pairing
// each 19-byte header block with its following data block. Headerless/turbo
// blocks are skipped (they cannot be translated anyway).
export function parseTAP(bytes) {
  const entries = [];
  let i = 0, pendingHeader = null;
  while (i + 2 <= bytes.length) {
    const len = bytes[i] | (bytes[i + 1] << 8);
    const block = bytes.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    if (block.length < 2) continue;
    const flag = block[0];
    if (flag === 0x00 && block.length === 19) {
      let name = '';
      for (let j = 2; j < 12; j++) name += String.fromCharCode(block[j]);
      pendingHeader = {
        type: block[1],
        name: name.trim(),
        dataLen: block[12] | (block[13] << 8),
        param1: block[14] | (block[15] << 8),
        param2: block[16] | (block[17] << 8),
      };
    } else if (flag === 0xFF && pendingHeader) {
      entries.push({
        ...pendingHeader,
        data: block.subarray(1, block.length - 1), // strip flag + checksum
      });
      pendingHeader = null;
    }
  }
  return entries;
}

// Wrap a tokenised BASIC program as a PLUS3DOS file (the on-disk format
// NextZXOS expects for autoexec.bas). autostartLine >= 0x8000 means "no
// autostart" in tape-header convention and is passed through unchanged.
export function plus3dosProgram(prog, autostartLine, varsOffset) {
  const out = new Uint8Array(128 + prog.length);
  const sig = 'PLUS3DOS';
  for (let i = 0; i < sig.length; i++) out[i] = sig.charCodeAt(i);
  out[8] = 0x1A;                       // soft-EOF
  out[9] = 1;                          // issue
  out[10] = 0;                         // version
  const total = out.length;
  out[11] = total & 0xFF; out[12] = (total >> 8) & 0xFF;
  out[13] = (total >> 16) & 0xFF; out[14] = (total >> 24) & 0xFF;
  // +3 BASIC header: type 0 = Program, length, autostart line, vars offset.
  out[15] = 0;
  out[16] = prog.length & 0xFF; out[17] = (prog.length >> 8) & 0xFF;
  out[18] = autostartLine & 0xFF; out[19] = (autostartLine >> 8) & 0xFF;
  out[20] = varsOffset & 0xFF; out[21] = (varsOffset >> 8) & 0xFF;
  let sum = 0;
  for (let i = 0; i < 127; i++) sum = (sum + out[i]) & 0xFF;
  out[127] = sum;
  out.set(prog, 128);
  return out;
}

// Translate TAP bytes into a Next delivery. Returns
//   { kind: 'bas', name, data }   for zxRunBas, or
//   { kind: 'nex', name, data }   for zxRunNex.
// Throws with a user-readable message when the TAP fits neither route.
export function tapToNext(bytes) {
  const entries = parseTAP(bytes);
  if (!entries.length) {
    throw new Error('no loadable blocks found in the tape file');
  }
  // Prefer a machine-code block in the .nex-able window: an asm project's
  // TAP is (BASIC loader + code), and the loader is tape-specific junk on
  // the Next, while the code block runs directly.
  const code = entries.find(e => e.type === 3 && e.param1 >= 0x8000 && e.param1 < 0xC000);
  if (code) {
    return {
      kind: 'nex',
      name: (code.name || 'program') + '.nex',
      data: makeNEX(code.data, code.param1),
    };
  }
  const bas = entries.find(e => e.type === 0);
  if (bas) {
    return {
      kind: 'bas',
      name: (bas.name || 'program') + '.bas',
      data: plus3dosProgram(bas.data, bas.param1, bas.param2),
    };
  }
  throw new Error('this tape has no BASIC program and no machine-code block at $8000-$BFFF, '
    + 'so it cannot be converted for the Next — load it on the 48K/128K instead');
}
