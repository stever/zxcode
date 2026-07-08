import logging
import tempfile
import base64
import os
from src.zxbc import main


def test_zxbasic():
    log = logging.getLogger()
    log.debug('Testing zxbasic')

    # Work entirely within a temp dir with an explicit -o output path: the
    # service runs read-only with only /tmp writable, so the compiler must
    # never rely on writing into the process CWD.
    workdir = tempfile.mkdtemp()
    bas_filename = os.path.join(workdir, 'program.bas')
    tap_filename = os.path.join(workdir, 'program.tap')
    log.debug(f'Basic filename: {bas_filename}')
    with open(bas_filename, 'w') as f:
        f.write('10 PRINT "Hello"')

    # Compile the tape file from basic source.
    main(['-f', 'tap', '-a', '-B', '-o', tap_filename, bas_filename])

    # Read and base64 encode the binary tape file.
    log.debug(f'Tape filename: {tap_filename}')
    with open(tap_filename, 'rb') as f:
        base64_encoded = base64.b64encode(f.read()).decode()
        log.debug(f'Base64 encoded: {base64_encoded}')

    os.remove(bas_filename)
    os.remove(tap_filename)
    os.rmdir(workdir)
