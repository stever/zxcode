import { CompileError } from './errors.js';
import { loadTool, mountShare, readCrt0 } from './wasm-tools.js';

// Mirrors the web app's 8bitworker C pipeline (Builder.ts PLATFORM_PARAMS).
const CODE_START = 0x8000;
const ROM_SIZE = 0xff58 - 0x8000;

function hexToArray(s: string, ofs: number): Uint8Array {
    const arr = new Uint8Array(s.length / 2);
    for (let i = 0; i < arr.length; i++) {
        arr[i] = parseInt(s.slice(i * 2 + ofs, i * 2 + ofs + 2), 16);
    }
    return arr;
}

// Intel HEX -> flat binary image starting at romStart, trimmed to the highest
// written byte (trailing uninitialised RAM is zeroed by crt0 at runtime, so no
// need to ship ~32 KB of zeros in the TAP).
function parseIHX(ihx: string, romStart: number, romSize: number): Uint8Array {
    const output = new Uint8Array(romSize);
    let highSize = 0;
    for (const s of ihx.split('\n')) {
        if (s[0] !== ':') continue;
        const arr = hexToArray(s, 1);
        const count = arr[0];
        const address = (arr[1] << 8) + arr[2] - romStart;
        const rectype = arr[3];
        if (rectype === 0) {
            for (let i = 0; i < count; i++) output[i + address] = arr[4 + i];
            if (count + address > highSize) highSize = count + address;
        } else if (rectype === 1) {
            break;
        }
    }
    return output.slice(0, highSize);
}

const text = (d: Uint8Array): string => Buffer.from(d).toString('utf8');

// Read an output file; throw a CompileError with the tool's stderr if it's
// missing or empty (warnings on stderr alone are not failures — output is).
function readOutput(instance: { FS: { readFile(p: string): Uint8Array } }, path: string, errors: string[], tool: string): Uint8Array {
    let out: Uint8Array | undefined;
    try {
        out = instance.FS.readFile(path);
    } catch {
        /* missing */
    }
    if (!out || out.length === 0) {
        throw new CompileError(errors.join('\n').slice(0, 500) || `${tool} produced no output`);
    }
    return out;
}

/**
 * Compile C (SDCC) to a self-loading TAP, replicating the browser pipeline:
 * mcpp (preprocess) -> sdcc --c1mode (compile, source on stdin) -> sdasz80
 * (assemble) -> sdldz80 (link with crt0 + z80 lib) -> Intel HEX -> bin2tap.
 */
export async function compileSdcc(code: string): Promise<Buffer> {
    // 1) Preprocess with mcpp (asm.js).
    const mcpp = loadTool('mcpp', { asmjs: true, config: { noFSInit: true } });
    mountShare(mcpp.instance);
    // Trailing newline avoids mcpp's benign "no newline at end" warning.
    mcpp.instance.FS.writeFile('main.c', code.endsWith('\n') ? code : `${code}\n`);
    mcpp.run([
        '-D', '__MAIN__',
        '-D', '__8BITWORKSHOP__',
        '-D', '__SDCC_z80',
        '-D', 'ZX',
        '-I', '/share/include',
        '-Q',
        'main.c', 'main.i',
    ]);
    let mcppErr = '';
    try {
        mcppErr = text(mcpp.instance.FS.readFile('mcpp.err'));
    } catch {
        /* no error file */
    }
    // mcpp.err also carries warnings; only fail on actual errors.
    if (/error:/i.test(mcppErr)) {
        throw new CompileError(mcppErr.slice(0, 500));
    }
    const preprocessed = text(readOutput(mcpp.instance, 'main.i', mcpp.errors, 'mcpp')).replace(
        /^#line /gm,
        '\n# ',
    );

    // 2) Compile with sdcc (--c1mode reads the preprocessed source on stdin).
    // Provide stdin via the Module config so Emscripten's own FS init wires it
    // (calling FS.init ourselves would abort — it's already initialised).
    let si = 0;
    const sdcc = loadTool('sdcc', {
        config: { stdin: () => (si < preprocessed.length ? preprocessed.charCodeAt(si++) : null) },
    });
    mountShare(sdcc.instance);
    const optimise = /^\s*#pragma\s+opt_code/m.test(code)
        ? []
        : ['--oldralloc', '--no-peep', '--nolospre'];
    sdcc.run([
        '--vc', '--std-sdcc99', '-mz80', '--c1mode', '--less-pedantic',
        ...optimise,
        '-o', 'main.asm',
    ]);
    const asm =
        ' .area _HOME\n .area _CODE\n .area _INITIALIZER\n .area _DATA\n' +
        ' .area _INITIALIZED\n .area _BSEG\n .area _BSS\n .area _HEAP\n' +
        text(readOutput(sdcc.instance, 'main.asm', sdcc.errors, 'sdcc'));

    // 3) Assemble with sdasz80.
    const sdas = loadTool('sdasz80');
    sdas.instance.FS.writeFile('main.asm', asm);
    sdas.run(['-plosgffwy', 'main.asm']);
    const rel = Uint8Array.from(readOutput(sdas.instance, 'main.rel', sdas.errors, 'sdasz80'));

    // 4) Link with sdldz80 (crt0 + z80 stdlib from /share).
    const sdld = loadTool('sdldz80');
    mountShare(sdld.instance);
    sdld.instance.FS.writeFile('main.rel', rel, { encoding: 'binary' });
    sdld.instance.FS.writeFile('crt0.rel', readCrt0(), { encoding: 'binary' });
    sdld.run([
        '-mjwxyu',
        '-i', 'main.ihx',
        '-b', `_CODE=0x${CODE_START.toString(16)}`,
        '-b', '_DATA=0xf000',
        '-k', '/share/lib/z80',
        '-l', 'z80',
        'crt0.rel', 'main.rel',
    ]);
    const ihx = text(readOutput(sdld.instance, 'main.ihx', sdld.errors, 'sdldz80'));

    // 5) Intel HEX -> binary -> self-loading TAP (ORG 0x8000).
    const bin = parseIHX(ihx, CODE_START, ROM_SIZE);
    const { bin2tap } = await import('pasmo');
    return Buffer.from(await bin2tap(bin));
}
