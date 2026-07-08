import logging
import tempfile
import base64
import os
import subprocess
from pathlib import Path


def test_compile():
    # NOTE: This test requires 'zcc' and probably other z88dk tools on PATH.

    log = logging.getLogger()
    log.debug('Testing C compiler')

    # Write C code to file.
    tmp = tempfile.NamedTemporaryFile()
    c_filename = f'{tmp.name}.c'
    log.debug(f'C filename: {c_filename}')
    with open(c_filename, 'w') as f:
        f.write("""#include <arch/zx.h>
#include <stdio.h>
 
int main()
{
  zx_cls(PAPER_WHITE);
  puts("Hello, world!");
  return 0;
}
""")

    try:
        # Compile the tape file from C source.
        path = os.path.dirname(os.path.abspath(c_filename))
        stem = Path(c_filename).stem
        out_filename = f'{os.path.join(path, stem)}'
        tap_filename = f'{out_filename}.tap'
        subprocess.run([
            'zcc',
            '+zx',
            '-vn',
            '-create-app',
            '-clib=sdcc_iy',
            '-startup=0',
            c_filename,
            '-o',
            out_filename
        ])

        assert os.path.exists(tap_filename)

        try:
            # Read and base64 encode the binary tape file.
            log.debug(f'Tape filename: {tap_filename}')
            with open(tap_filename, 'rb') as f:
                base64_encoded = base64.b64encode(f.read()).decode()
                log.debug(f'Base64 encoded: {base64_encoded}')

        finally:
            os.remove(tap_filename)

    finally:
        os.remove(c_filename)


def test_compile_classic_lib():
    # Classic-library source (<spectrum.h>) must build with the classic clib
    # and -lndos, mirroring app.routes.compile.zcc_args detection.

    from app.routes.compile import zcc_args

    source = """#include <stdio.h>
#include <spectrum.h>

int main(void)
{
    zx_border(INK_BLUE);
    zx_colour(PAPER_BLACK | INK_WHITE);
    zx_cls();
    printf("Hello from z88dk!\\n");
    return 0;
}
"""
    assert '-lndos' in zcc_args(source)
    assert '-clib=sdcc_iy' in zcc_args("#include <arch/zx.h>\nint main(){return 0;}")

    tmp = tempfile.NamedTemporaryFile()
    c_filename = f'{tmp.name}.c'
    with open(c_filename, 'w') as f:
        f.write(source)

    try:
        path = os.path.dirname(os.path.abspath(c_filename))
        stem = Path(c_filename).stem
        out_filename = f'{os.path.join(path, stem)}'
        tap_filename = f'{out_filename}.tap'
        subprocess.run([*zcc_args(source), c_filename, '-o', out_filename])

        assert os.path.exists(tap_filename)
        os.remove(tap_filename)

    finally:
        os.remove(c_filename)
