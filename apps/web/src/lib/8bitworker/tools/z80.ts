import {
    anyTargetChanged,
    gatherFiles,
    populateFiles,
    putWorkFile,
    staleFiles
} from "../files";
import {emglobal} from "../shared_vars";
import {EmscriptenModule, loadWASM, instantiateWASM} from "../modules";
import {parseZmacListing} from "../parsing";
import {print_fn, makeErrorMatcher} from "../shared_funcs";
import {BuildStep} from "../defs_build";
import {BuildStepResult, CodeListingMap} from "../defs_build_result";

export function assembleZMAC(step: BuildStep): BuildStepResult {
    loadWASM("zmac");

    let lstout, binout;
    const errors = [];

    gatherFiles(step);

    const lstpath = step.prefix + ".lst";
    const binpath = step.prefix + ".cim";

    if (staleFiles(step, [binpath, lstpath])) {
        const ZMAC: EmscriptenModule = emglobal.zmac({
            instantiateWasm: instantiateWASM('zmac'),
            noInitialRun: true,
            //logReadFiles:true,
            print: print_fn,
            printErr: makeErrorMatcher(errors, /([^( ]+)\s*[(](\d+)[)]\s*:\s*(.+)/, 2, 3, step.path),
        } as BuildStep);

        const FS = ZMAC.FS;
        populateFiles(step, FS);
        ZMAC.callMain(['-z', '-c', '--oo', 'lst,cim', step.path]);

        if (errors.length) {
            return {errors: errors};
        }

        lstout = FS.readFile("zout/" + lstpath, {encoding: 'utf8'});
        binout = FS.readFile("zout/" + binpath, {encoding: 'binary'});

        putWorkFile(binpath, binout);
        putWorkFile(lstpath, lstout);

        /*
        if (!anyTargetChanged(step, [binpath, lstpath])) {
            return;
        }
        */

        // `LINE:\tADDR  BYTES\tsource`, with `**** file ****` banners at
        // include switches — parsed per file so multi-file sources
        // attribute correctly (SourceSnippet.path; undefined = main).
        const lines = parseZmacListing(lstout, step.path);
        const listings: CodeListingMap = {};
        listings[lstpath] = {lines: lines};

        // parse symbol table
        const symbolmap = {};
        const sympos = lstout.indexOf('Symbol Table:');
        if (sympos > 0) {
            const symout = lstout.slice(sympos + 14);
            symout.split('\n').forEach(function (l) {
                const m = l.match(/(\S+)\s+([= ]*)([0-9a-f]+)/i);
                if (m) {
                    symbolmap[m[1]] = parseInt(m[3], 16);
                }
            });
        }

        return {
            output: binout,
            listings: listings,
            errors: errors,
            symbolmap: symbolmap
        };
    }
}
