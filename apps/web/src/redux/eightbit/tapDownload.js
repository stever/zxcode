import {tapToNext} from "@zxplay/emulator/tapToNext";

// The compilers' "tap" payload is not always a tape: NextBASIC (txt2bas)
// arrives as a PLUS3DOS program and sjasmplus SAVENEX as a NEX image. These
// signatures mirror the load sniffing in GoEmulator.openTapeBytes.
const PLUS3DOS_SIG = [0x50, 0x4C, 0x55, 0x53, 0x33, 0x44, 0x4F, 0x53];
const NEX_SIG = [0x4E, 0x65, 0x78, 0x74];

function hasSignature(data, sig) {
    return data.length >= sig.length && sig.every((b, i) => data[i] === b);
}

// Decide the download payload and file extension for compiled bytes on the
// given machine. On the Next a TAP is translated exactly as the run path
// does (tapToNext), so the download is the artifact the emulator runs — a
// .nex for .nexload, or a PLUS3DOS .bas NextZXOS can LOAD from SD. Throws
// tapToNext's user-readable error when the TAP cannot be converted.
export function tapDownloadFile(data, machine) {
    if (hasSignature(data, NEX_SIG)) return {bytes: data, ext: 'nex'};
    if (hasSignature(data, PLUS3DOS_SIG)) return {bytes: data, ext: 'bas'};
    if (String(machine) === 'next') {
        const next = tapToNext(data);
        return {bytes: next.data, ext: next.kind === 'bas' ? 'bas' : 'nex'};
    }
    return {bytes: data, ext: 'tap'};
}
