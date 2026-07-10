import {
    anyTargetChanged,
    gatherFiles,
    getWorkFileAsString,
    populateExtraFiles,
    populateFiles,
    putWorkFile,
    staleFiles
} from "../files";
import {emglobal} from "../shared_vars";
import {EmscriptenModule, loadWASM, instantiateWASM} from "../modules";
import {setupFS} from "../files";
import {preprocessMCPP} from "./mcpp";
import {parseListing, parseSourceLinesWithFiles} from "../parsing";
import {print_fn} from "../shared_funcs";
import {BuildStep} from "../defs_build";
import {BuildStepResult, CodeListingMap, WorkerError} from "../defs_build_result";

function hexToArray(s, ofs) {
    const buf = new ArrayBuffer(s.length / 2);
    const arr = new Uint8Array(buf);

    for (let i = 0; i < arr.length; i++) {
        arr[i] = parseInt(s.slice(i * 2 + ofs, i * 2 + ofs + 2), 16);
    }

    return arr;
}

function parseIHX(ihx, rom_start, rom_size) {
    const output = new Uint8Array(new ArrayBuffer(rom_size));
    let high_size = 0;

    for (let s of ihx.split("\n")) {
        if (s[0] == ':') {
            const arr = hexToArray(s, 1);
            const count = arr[0];
            const address = (arr[1] << 8) + arr[2] - rom_start;
            const rectype = arr[3];
            //console.log(rectype, address.toString(16), count, arr);

            if (rectype == 0) {
                let i;

                for (i = 0; i < count; i++) {
                    output[i + address] = arr[4 + i];
                }

                if (i + address > high_size) {
                    high_size = i + address;
                }
            } else if (rectype == 1) {
                break;
            } else {
                console.log(s); // unknown record type
            }
        }
    }

    return output;
}

export function assembleSDASZ80(step: BuildStep): BuildStepResult {
    loadWASM("sdasz80");

    let objout, lstout;
    const errors = [];

    gatherFiles(step);

    const objpath = step.prefix + ".rel";
    const lstpath = step.prefix + ".lst";

    if (staleFiles(step, [objpath, lstpath])) {
        //?ASxxxx-Error-<o> in line 1 of main.asm null
        //              <o> .org in REL area or directive / mnemonic error
        // ?ASxxxx-Error-<q> in line 1627 of cosmic.asm
        //    <q> missing or improper operators, terminators, or delimiters
        const match_asm_re1 = / in line (\d+) of (\S+)/;
        const match_asm_re2 = / <\w> (.+)/;
        let errline = 0;
        let errpath = step.path;

        const match_asm_fn = (s: string) => {
            let m = match_asm_re1.exec(s);
            if (m) {
                errline = parseInt(m[1]);
                errpath = m[2];
            } else {
                m = match_asm_re2.exec(s);
                if (m) {
                    errors.push({
                        line: errline,
                        path: errpath,
                        msg: m[1]
                    });
                }
            }
        }

        const ASZ80: EmscriptenModule = emglobal.sdasz80({
            instantiateWasm: instantiateWASM('sdasz80'),
            noInitialRun: true,
            //logReadFiles:true,
            print: match_asm_fn,
            printErr: match_asm_fn,
        });

        const FS = ASZ80.FS;

        populateFiles(step, FS);

        ASZ80.callMain(['-plosgffwy', step.path]);

        if (errors.length) {
            return {errors: errors};
        }

        objout = FS.readFile(objpath, {encoding: 'utf8'});
        lstout = FS.readFile(lstpath, {encoding: 'utf8'});

        putWorkFile(objpath, objout);
        putWorkFile(lstpath, lstout);
    }

    return {
        linktool: "sdldz80",
        files: [objpath, lstpath],
        args: [objpath]
    };
}

export function linkSDLDZ80(step: BuildStep) {
    loadWASM("sdldz80");

    const errors = [];

    gatherFiles(step);

    const binpath = "main.ihx";

    if (staleFiles(step, [binpath])) {
        const match_aslink_re = /\?ASlink-(\w+)-(.+)/;

        const match_aslink_fn = (s: string) => {
            const matches = match_aslink_re.exec(s);
            if (matches) {
                errors.push({
                    line: 0,
                    msg: matches[2]
                });
            }
        }

        const params = step.params;

        const LDZ80: EmscriptenModule = emglobal.sdldz80({
            instantiateWasm: instantiateWASM('sdldz80'),
            noInitialRun: true,
            //logReadFiles:true,
            print: match_aslink_fn,
            printErr: match_aslink_fn,
        } as BuildStep);

        const FS = LDZ80.FS;

        setupFS(FS, 'sdcc');
        populateFiles(step, FS);
        populateExtraFiles(step, FS, params.extra_link_files);

        const args = [
            '-mjwxyu',
            '-i', 'main.ihx',
            '-b', '_CODE=0x' + params.code_start.toString(16),
            '-b', '_DATA=0x' + params.data_start.toString(16),
            '-k', '/share/lib/z80',
            '-l', 'z80'
        ];

        if (params.extra_link_args) {
            args.push.apply(args, params.extra_link_args);
        }

        args.push.apply(args, step.args);
        //console.log(args);

        LDZ80.callMain(args);

        if (errors.length) {
            return {errors};
        }

        const hexout = FS.readFile("main.ihx", {encoding: 'utf8'});
        const noiout = FS.readFile("main.noi", {encoding: 'utf8'});

        putWorkFile("main.ihx", hexout);
        putWorkFile("main.noi", noiout);

        /*
        // TODO: return unchanged if no files changed?
        if (!anyTargetChanged(step, ["main.ihx", "main.noi"])) {
            return;
        }
        */

        // parse binary file
        const binout = parseIHX(
            hexout,
            params.code_start,
            params.rom_size);

        // parse listings
        const listings: CodeListingMap = {};
        for (let fn of step.files) {
            if (fn.endsWith('.lst')) {
                const rstout = FS.readFile(fn.replace('.lst', '.rst'), {encoding: 'utf8'});
                //   0000 21 02 00      [10]   52 	ld	hl, #2
                const asmlines = parseListing(rstout, /^\s*([0-9A-F]{4})\s+([0-9A-F][0-9A-F r]*[0-9A-F])\s+\[([0-9 ]+)\]?\s+(\d+) (.*)/i, 4, 1, 2, 3);
                // C-line markers carry the file: `<stdin>` for the piped
                // main source, the include path for #include'd files — so
                // srclines attribute per file (SourceSnippet.path).
                const srclines = parseSourceLinesWithFiles(rstout, /^\s+\d+ ;([^\s:][^:]*):(\d+):/i, /^\s*([0-9A-F]{4})/i);
                putWorkFile(fn, rstout);
                listings[fn] = {
                    asmlines: srclines.length ? asmlines : null,
                    lines: srclines.length ? srclines : asmlines,
                    text: rstout
                };
            }
        }

        // parse symbol map
        const symbolmap = {};
        for (let s of noiout.split("\n")) {
            const toks = s.split(" ");
            if (toks[0] == 'DEF' && !toks[1].startsWith("A$")) {
                symbolmap[toks[1]] = parseInt(toks[2], 16);
            }
        }

        // build segment map
        const seg_re = /^s__(\w+)$/;
        const segments = [];
        for (let ident in symbolmap) {
            let m = seg_re.exec(ident);

            if (m) {
                let seg = m[1];
                let segstart = symbolmap[ident]; // s__SEG
                let segsize = symbolmap['l__' + seg]; // l__SEG

                if (segstart >= 0 && segsize > 0) {
                    let type = null;

                    if (['INITIALIZER', 'GSINIT', 'GSFINAL'].includes(seg)) {
                        type = 'rom';
                    } else if (seg.startsWith('CODE')) {
                        type = 'rom';
                    } else if (['DATA', 'INITIALIZED'].includes(seg)) {
                        type = 'ram';
                    }

                    if (type == 'rom' || segstart > 0) { // ignore HEADER0, CABS0, etc
                        segments.push({
                            name: seg,
                            start: segstart,
                            size: segsize,
                            type: type
                        });
                    }
                }
            }
        }

        return {
            output: binout,
            listings: listings,
            errors: errors,
            symbolmap: symbolmap,
            segments: segments
        };
    }
}

export function compileSDCC(step: BuildStep): BuildStepResult {
    gatherFiles(step);

    const outpath = step.prefix + ".asm";
    if (staleFiles(step, [outpath])) {
        const errors = [];

        loadWASM('sdcc');

        const SDCC: EmscriptenModule = emglobal.sdcc({
            instantiateWasm: instantiateWASM('sdcc'),
            noInitialRun: true,
            noFSInit: true,
            print: print_fn,
            printErr: msvcErrorMatcher(errors),
            //TOTAL_MEMORY:256*1024*1024,
        });

        const FS = SDCC.FS;

        populateFiles(step, FS);

        // load source file and preprocess
        let code = getWorkFileAsString(step.path);
        const preproc = preprocessMCPP(step, 'sdcc');
        if (preproc.errors) {
            return {errors: preproc.errors};
        } else {
            code = preproc.code;
        }

        // pipe file to stdin
        setupStdin(FS, code);
        setupFS(FS, 'sdcc');

        const args = [
            '--vc',
            '--std-sdcc99',
            '-mz80',
            //'-Wall',
            '--c1mode',
            //'--debug',
            //'-S', 'main.c',
            //'--asm=sdasz80',
            //'--reserve-regs-iy',
            '--less-pedantic',
            ///'--fomit-frame-pointer',
            //'--opt-code-speed',
            //'--max-allocs-per-node', '1000',
            //'--cyclomatic',
            //'--nooverlay',
            //'--nogcse',
            //'--nolabelopt',
            //'--noinvariant',
            //'--noinduction',
            //'--nojtbound',
            //'--noloopreverse',
            '-o', outpath
        ];

        // if "#pragma opt_code" found do not disable optimziations
        if (!/^\s*#pragma\s+opt_code/m.exec(code)) {
            args.push.apply(args, [
                '--oldralloc',
                '--no-peep',
                '--nolospre'
            ]);
        }

        SDCC.callMain(args);

        if (errors.length /* && nwarnings < msvc_errors.length*/) {
            return {errors: errors};
        }

        // massage the asm output
        const asmout =
            " .area _HOME\n" +
            " .area _CODE\n" +
            " .area _INITIALIZER\n" +
            " .area _DATA\n" +
            " .area _INITIALIZED\n" +
            " .area _BSEG\n" +
            " .area _BSS\n" +
            " .area _HEAP\n" + FS.readFile(outpath, {encoding: 'utf8'});

        putWorkFile(outpath, asmout);
    }

    return {
        nexttool: "sdasz80",
        path: outpath,
        args: [outpath],
        files: [outpath],
    };
}

function setupStdin(fs, code: string) {
    let i = 0;
    fs.init(
        function () {
            return i < code.length ? code.charCodeAt(i++) : null;
        }
    );
}

// test.c(6) : warning 85: in function main unreferenced local variable : 'x'
// main.a (4): error: Unknown Mnemonic 'xxx'.
// at 2: warning 190: ISO C forbids an empty source file
const re_msvc = /[/]*([^( ]+)\s*[(](\d+)[)]\s*:\s*(.+?):\s*(.*)/;
const re_msvc2 = /\s*(at)\s+(\d+)\s*(:)\s*(.*)/;

function msvcErrorMatcher(errors: WorkerError[]) {
    return function (s: string) {
        const matches = re_msvc.exec(s) || re_msvc2.exec(s);
        if (matches) {
            const errline = parseInt(matches[2]);
            errors.push({
                line: errline,
                path: matches[1],
                msg: matches[4]
            });
        } else {
            console.log(s);
        }
    }
}
