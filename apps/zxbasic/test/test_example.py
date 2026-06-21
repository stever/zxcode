import logging
import tempfile
import base64
import os
from pathlib import Path
from src.zxbc import main


def test_zxbasic():
    log = logging.getLogger()
    log.debug('Testing zxbasic')

    # Write ZX Basic to file.
    tmp = tempfile.NamedTemporaryFile()
    bas_filename = f'{tmp.name}.bas'
    log.debug(f'Basic filename: {bas_filename}')
    with open(bas_filename, 'w') as f:
        f.write('10 PRINT "Hello"')

    # Compile the tape file from basic source.
    main(['-f', 'tap', '-a', '-B', bas_filename])

    # Read and base64 encode the binary tape file.
    tap_filename = f'{Path(bas_filename).stem}.tap'
    log.debug(f'Tape filename: {tap_filename}')
    with open(tap_filename, 'rb') as f:
        base64_encoded = base64.b64encode(f.read()).decode()
        log.debug(f'Base64 encoded: {base64_encoded}')

    os.remove(bas_filename)
    os.remove(tap_filename)
