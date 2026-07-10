import {SourceSnippet} from "./defs_build_result";

const re_crlf = /\r?\n/;
const re_lineoffset = /\s*(\d+)\s+[%]line\s+(\d+)\+(\d+)\s+(.+)/;

export function parseListing(code: string,
                             lineMatch,
                             iline: number,
                             ioffset: number,
                             iinsns: number,
                             icycles?: number,
                             funcMatch?, segMatch?): SourceSnippet[] {

    const lines: SourceSnippet[] = [];

    let lineofs = 0;
    let segment = '';
    let func = '';
    let funcbase = 0;

    code.split(re_crlf).forEach((line, lineindex) => {
        let segm = segMatch && segMatch.exec(line);
        if (segm) {
            segment = segm[1];
        }

        let funcm = funcMatch && funcMatch.exec(line);
        if (funcm) {
            funcbase = parseInt(funcm[1], 16);
            func = funcm[2];
        }

        const linem = lineMatch.exec(line);
        if (linem && linem[1]) {
            const linenum = iline < 0 ? lineindex : parseInt(linem[iline]);
            const offset = parseInt(linem[ioffset], 16);
            const insns = linem[iinsns];
            const cycles: number = icycles ? parseInt(linem[icycles]) : null;
            const iscode = cycles > 0;

            if (insns) {
                lines.push({
                    line: linenum + lineofs,
                    offset: offset - funcbase,
                    insns,
                    cycles,
                    iscode,
                    segment,
                    func
                });
            }
        } else {
            let m = re_lineoffset.exec(line);
            if (m) {
                lineofs = parseInt(m[2]) - parseInt(m[1]) - parseInt(m[3]);
            }
        }
    });

    return lines;
}

// Like parseSourceLines, but the marker regex captures (path, line) so
// multi-file sources attribute correctly: SDCC's .rst listings mark C lines
// as `;<path>:<line>:` where <path> is `<stdin>` for the piped main source
// and the include path as written for everything else. Each marker applies
// to the next offset-bearing row.
export function parseSourceLinesWithFiles(code: string, lineMatch, offsetMatch): SourceSnippet[] {
    const lines: SourceSnippet[] = [];
    let pending: { path: string, line: number } = null;

    for (let line of code.split(re_crlf)) {
        let linem = lineMatch.exec(line);
        if (linem && linem[1]) {
            pending = {path: linem[1], line: parseInt(linem[2])};
            continue;
        }
        if (pending) {
            linem = offsetMatch.exec(line);
            if (linem && linem[1]) {
                lines.push({
                    line: pending.line,
                    offset: parseInt(linem[1], 16),
                    path: pending.path,
                });
                pending = null;
            }
        }
    }

    return lines;
}

// zmac listings interleave include files, marking each switch with a
// `**** <path> ****` banner and restarting line numbers per file. Rows are
// `LINE:\tADDR  BYTES\tsource`; only byte-emitting rows map (org/label-only
// rows carry no bytes). `path` is undefined for the main file's rows and
// the include path as written otherwise.
export function parseZmacListing(code: string, mainpath: string): SourceSnippet[] {
    const lines: SourceSnippet[] = [];
    let path: string = undefined;

    for (const row of code.split(re_crlf)) {
        const banner = /^\*{4} (.+?) \*{4}\s*$/.exec(row);
        if (banner) {
            path = banner[1] === mainpath ? undefined : banner[1];
            continue;
        }
        const m = /^\s*(\d+):\s*([0-9a-f]{4})\s+([0-9a-f]+)\s/i.exec(row);
        if (m) {
            lines.push({
                line: parseInt(m[1]),
                offset: parseInt(m[2], 16),
                insns: m[3],
                path,
            });
        }
    }

    return lines;
}

export function parseSourceLines(code: string, lineMatch, offsetMatch, funcMatch?, segMatch?) {
    const lines = [];

    let lastlinenum = 0;
    let segment = '';
    let func = '';
    let funcbase = 0;

    for (let line of code.split(re_crlf)) {
        let segm = segMatch && segMatch.exec(line);
        if (segm) {
            segment = segm[1];
        }

        let funcm = funcMatch && funcMatch.exec(line);
        if (funcm) {
            funcbase = parseInt(funcm[1], 16);
            func = funcm[2];
        }

        let linem = lineMatch.exec(line);
        if (linem && linem[1]) {
            lastlinenum = parseInt(linem[1]);
        } else if (lastlinenum) {
            linem = offsetMatch.exec(line);
            if (linem && linem[1]) {
                const offset = parseInt(linem[1], 16);

                lines.push({
                    line: lastlinenum,
                    offset: offset - funcbase,
                    segment,
                    func
                });

                lastlinenum = 0;
            }
        }
    }

    return lines;
}
