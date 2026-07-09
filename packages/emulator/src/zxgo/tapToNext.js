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

export function makeNEX(bin, org = 0x8000, entry = org) {
  const BANK = 0x4000;
  // Code below $8000 (the classic `org 30000` convention — bank 5 alongside
  // the screen and system variables) cannot be shipped as a bank-5 image:
  // .nex banks are whole 16K, and zero-filling the rest of bank 5 would
  // stomp the sysvars that ROM routines (RST $10 printing etc.) depend on.
  // Instead stage the code in bank 2 behind a stub at $8000 that relocates
  // it to its true org and CALLS the entry point emulating the BASIC
  // loader's RANDOMIZE USR environment: these programs are written as USR
  // routines, so they assume IY = sysvars, an open print channel, and a
  // sane stack to RET to. After the RET, hold so the output stays visible
  // (the 48K equivalent leaves you at the report; use Reset to leave).
  if (org >= 0x5B00 && org < 0x8000) {
    if (org + bin.length > 0x8000)
      throw new Error(`zxnext: low-org program crosses $8000 (org ${org}, ${bin.length} bytes)`);
    if (bin.length > BANK - 32)
      throw new Error(`zxnext: low-org program too large to stage (${bin.length} bytes)`);
    const staged = new Uint8Array(32 + bin.length);
    const w = (off, v) => { staged[off] = v & 0xFF; staged[off + 1] = (v >> 8) & 0xFF; };
    staged[0] = 0xFD; staged[1] = 0x21; w(2, 0x5C3A); // LD IY,$5C3A (ERR-NR: ROM convention)
    staged[4] = 0x3E; staged[5] = 0x02;               // LD A,2 (upper screen stream)
    staged[6] = 0xCD; w(7, 0x1601);                   // CALL $1601 CHAN-OPEN (ROM3 is paged)
    staged[9] = 0xED; staged[10] = 0x56;              // IM 1 (BASIC's USR runs with
    staged[11] = 0xFB;                                // EI — .nexload hands over DI'd)
    staged[12] = 0x21; w(13, 0x8020);                 // LD HL, staging area
    staged[15] = 0x11; w(16, org);                    // LD DE, org
    staged[18] = 0x01; w(19, bin.length);             // LD BC, length
    staged[21] = 0xED; staged[22] = 0xB0;             // LDIR
    staged[23] = 0xCD; w(24, entry);                  // CALL entry (RET-safe)
    staged[26] = 0x18; staged[27] = 0xFE;             // JR $ — hold the final screen
    staged.set(bin, 32);
    return makeNEX(staged, 0x8000, 0x8000);
  }
  if (org < 0x8000 || org >= 0xC000)
    throw new Error(`zxnext: org $${org.toString(16)} unsupported (need $5B00-$BFFF)`);
  if (org + bin.length > 0x10000)
    throw new Error(`zxnext: program overruns $FFFF (org $${org.toString(16)}, ${bin.length} bytes)`);
  if (entry < org || entry >= org + bin.length) entry = org;

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
  // (bank 0 may also be added below to host the USR-environment stub)

  // High-org code arrives via a BASIC loader's RANDOMIZE USR on tape, so it
  // may assume that environment and RET at the end (Boriel BASIC's runtime
  // does exactly this — the RET lands on a garbage stack and crashes to a
  // reboot). When bank 0 ($C000) is free, enter through a small stub there
  // that sets IY, opens channel 2, CALLs the entry and then holds the final
  // screen; programs that own bank 0 get direct entry (they overwhelmingly
  // run forever rather than RET).
  let pc = entry;
  if (!usesBank0) {
    const w = (off, v) => { bank0[off] = v & 0xFF; bank0[off + 1] = (v >> 8) & 0xFF; };
    bank0[0] = 0xFD; bank0[1] = 0x21; w(2, 0x5C3A);   // LD IY,$5C3A
    bank0[4] = 0x3E; bank0[5] = 0x02;                 // LD A,2
    bank0[6] = 0xCD; w(7, 0x1601);                    // CALL $1601 CHAN-OPEN
    bank0[9] = 0xED; bank0[10] = 0x56;                // IM 1 (BASIC's USR runs with
    bank0[11] = 0xFB;                                 // EI — .nexload hands over DI'd)
    bank0[12] = 0xCD; w(13, entry);                   // CALL entry (RET-safe)
    bank0[15] = 0x18; bank0[16] = 0xFE;               // JR $ — hold the screen
    banks.push([0, bank0]);
    pc = 0xC000;
  }

  const header = new Uint8Array(512);
  const w16 = (off, v) => { header[off] = v & 0xFF; header[off + 1] = v >> 8; };
  header.set([0x4E, 0x65, 0x78, 0x74], 0);           // "Next"
  header.set([0x56, 0x31, 0x2E, 0x32], 4);           // "V1.2"
  header[8] = 0;                                      // RAM required: 768K
  header[9] = banks.length;                           // banks to load
  header[10] = 0;                                     // no loading screen
  header[11] = 0;                                     // border black
  w16(12, 0x7FFE);                                    // SP (top of bank 5 slot)
  w16(14, pc);                                        // PC = entry (or the stub)
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
// each 19-byte header block with its following data block. Headerless data
// blocks come through as type -1 (sjasmplus SAVETAP delivers the actual
// program that way); turbo/custom blocks are skipped.
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
    } else if (flag === 0xFF) {
      entries.push({
        type: -1, name: '', dataLen: block.length - 2, param1: 0, param2: 0,
        data: block.subarray(1, block.length - 1),
      });
    }
  }
  return entries;
}

// sjasmplus SAVETAP does not write a plain headered CODE block at the org.
// Its tape is: BASIC bootstrap -> a small type-3 second-stage loader at
// $5Exx -> the program as a HEADERLESS memory dump. The loader ends with a
// parameter table the second stage reads for its own LD-BYTES call — three
// little-endian words: entry, load address, length. Length matching a
// headerless block is the fingerprint (a generic $5Exx code block would
// have no reason to end with a following block's exact byte count).
// Returns {data, org, entry} for makeNEX, or null when the tape is not
// this shape.
function findSjasmplusPayload(entries) {
  for (const e of entries) {
    if (e.type !== 3 || e.data.length < 8 || e.data.length > 128) continue;
    if (e.param1 < 0x5B00 || e.param1 >= 0x6000) continue;
    const t = e.data, n = t.length;
    const w = (off) => t[off] | (t[off + 1] << 8);
    const entry = w(n - 6), org = w(n - 4), length = w(n - 2);
    if (org < 0x4000 || org + length > 0x10000 || length === 0) continue;
    if (entry < org || entry >= org + length) continue;
    const payload = entries.find(
      (h) => h.type === -1 && h.data.length === length);
    if (!payload) continue;
    return {data: payload.data, org, entry};
  }
  return null;
}

// Wrap a tokenised BASIC program as a PLUS3DOS file (the on-disk format
// NextZXOS LOADs from SD). autostartLine >= 0x8000 means "no autostart" in
// tape-header convention and is passed through unchanged; with an autostart
// line the program runs as soon as the command-line macro LOADs it.
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

// findUsrEntry scans a tokenised BASIC loader for `USR n` (the token $C0
// followed by ASCII digits) and returns n — the real entry point of a
// loader-style tape, which need not equal the code block's load address.
export function findUsrEntry(prog) {
  for (let i = 0; i < prog.length; i++) {
    if (prog[i] !== 0xC0) continue;
    let j = i + 1, n = 0, seen = false;
    while (j < prog.length && prog[j] >= 0x30 && prog[j] <= 0x39) {
      n = n * 10 + (prog[j] - 0x30); seen = true; j++;
    }
    if (seen && n >= 0x4000 && n < 0x10000) return n;
  }
  return null;
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
  const codeBlocks = entries.filter(e => e.type === 3);
  const basBlocks = entries.filter(e => e.type === 0);
  // sjasmplus SAVETAP: the only headered code block is its second-stage
  // TAPE loader — shipping that would leave the Next polling a tape that
  // does not exist (the Next never tape-loads; that is the whole reason
  // this translation exists). The program itself is the headerless dump;
  // org and entry come from the loader's parameter table.
  const sjasm = findSjasmplusPayload(entries);
  if (sjasm) {
    const basName = basBlocks.length ? basBlocks[0].name : '';
    let base = (basName || '').toLowerCase()
      .replace(/[^a-z0-9_-]/g, '').slice(0, 8);
    if (!base) base = 'program';
    return {
      kind: 'nex',
      name: base + '.nex',
      data: makeNEX(sjasm.data, sjasm.org, sjasm.entry),
    };
  }
  // Any code block makes this a loader-style tape: the machine code is the
  // program and the BASIC block (if any) is tape-loading scaffolding that
  // must NOT be run on the Next. Entry point comes from the loader's
  // RANDOMIZE USR when present, else the code's load address.
  if (codeBlocks.length) {
    const code = codeBlocks.find(e => e.param1 >= 0x5B00 && e.param1 < 0xC000);
    if (!code) {
      throw new Error('this tape\'s machine code loads outside $5B00-$BFFF, '
        + 'which cannot be converted for the Next — load it on the 48K/128K instead');
    }
    const usr = basBlocks.length ? findUsrEntry(basBlocks[0].data) : null;
    // Name must be a clean FAT 8.3 base: longer names get a `~1` alias on
    // the SD card, and the nexload macro cannot type '~' on the Spectrum
    // matrix — the typed path then misses the stored file ("No such file").
    // pasmo also names its code block after the OUTPUT FILE ("output.tap"),
    // so strip artefact extensions.
    let base = (code.name || '').toLowerCase()
      .replace(/\.(tap|tzx|nex|bin|out)$/, '')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 8);
    if (!base) base = 'program';
    return {
      kind: 'nex',
      name: base + '.nex',
      data: makeNEX(code.data, code.param1, usr !== null ? usr : code.param1),
    };
  }
  if (basBlocks.length) {
    const bas = basBlocks[0];
    let base = (bas.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 8);
    if (!base) base = 'program';
    return {
      kind: 'bas',
      name: base + '.bas',
      data: plus3dosProgram(bas.data, bas.param1, bas.param2),
    };
  }
  throw new Error('this tape has no BASIC program and no machine-code block, '
    + 'so it cannot be converted for the Next — load it on the 48K/128K instead');
}
