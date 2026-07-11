"""Driver for `zxbasm` producing a TAP with a BASIC loader.

Works around an upstream CLI bug in the pinned zxbasic release: the
`-f/--output-format` option defaults truthily to "bin", which makes the
deprecated `-t`/`-T` branches dead code (the format never changes), while
the BASIC-loader validation accepts ONLY `-t`/`-T` — so "tap with loader"
is unreachable through zxbasm's own command line. This driver runs the
standard zxbasm main() with `-t -a -B` (satisfying the validation and the
loader flags) and forces the emit format to tap at the generate_binary
seam.

Run as a subprocess (`python -m app.zxbasm_tap <zxbasm args>`) so the
toolchain's global OPTIONS singleton never touches the service process —
the compile endpoint is threaded and must not share compiler globals
across requests.
"""
import sys

import src.zxbasm.asmparse as asmparse
from src.zxbasm import zxbasm

_generate_binary = asmparse.generate_binary


def _force_tap(outputfname, _format, *args, **kwargs):
    return _generate_binary(outputfname, 'tap', *args, **kwargs)


asmparse.generate_binary = _force_tap

if __name__ == '__main__':
    sys.exit(zxbasm.main(sys.argv[1:]))
