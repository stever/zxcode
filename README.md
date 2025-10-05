# Code . ZX Play

A ZX Spectrum emulator & programming environment for the browser.

## Development Notes

### Local Development

Minimum pre-requisites:

- Docker with Docker Compose (https://docs.docker.com/get-docker/)
- Caddy web server (https://caddyserver.com/) caddy command installed and in PATH
- Microsoft .NET 8 SDK (https://dotnet.microsoft.com/en-us/download/dotnet/8.0)

```bash
# Create .env files from example .env-dist files
cp .env-dist .env
cp apps/proxy/.env-dist apps/proxy/.env

# Set env vars before starting containers
export HASURA_GRAPHQL_ADMIN_SECRET=hasurapassword

# Start up containers
docker compose up --build -d

# Wait for Hasura to start
bash -c 'while [[ "$(curl -s -o /dev/null -w ''%{http_code}'' localhost:4000/healthz)" != "200" ]]; do sleep 5; done'
```

```bash
npm install
npm run dev
```

Launch the URL for the proxied web server on port 8080 (http://localhost:8080).

### Docker Commands

Remove docker compose deployment to start over:

```bash
docker compose stop && docker compose rm -f
docker volume rm zxcoder_pg_data
```

Refresh and restart docker-compose deployment:

```bash
docker compose pull
docker compose up --build -d
```

### HTTP Local Ports Used

| Port | Purpose        | Protocol |
| ---- | -------------- | -------- |
| 4000 | Hasura GraphQL | HTTP     |
| 5000 | Auth           | HTTP     |
| 8000 | React          | HTTP     |
| 8080 | Proxy          | HTTP     |

## JSSpeccy3 Core

Based on [JSSpeccy3](https://github.com/gasman/jsspeccy3).

This is a personal fork for some customisation also using mods from other forks.

### Features

- Emulates the Spectrum 48K, Spectrum 128K and Pentagon machines
- Handles all Z80 instructions, documented and undocumented
- Cycle-accurate emulation of scanline / multicolour effects
- AY and beeper audio
- Loads SZX, Z80 and SNA snapshots
- Loads TZX and TAP tape images (via traps only)
- Loads any of the above files from inside a ZIP file
- 100% / 200% / 300% and fullscreen display modes

### Implementation notes

JSSpeccy 3 is a complete rewrite of JSSpeccy to make full use of the web technologies
and APIs available as of 2021 for high-performance web apps. The emulation runs in a
Web Worker, freeing up the UI thread to handle screen and audio updates, with the
emulator core (consisting of the Z80 processor emulation and any auxiliary processes
that are likely to interrupt its execution multiple times per frame, such as constructing
the video output, reading the keyboard and generating audio) running in WebAssembly,
compiled from AssemblyScript (with a custom preprocessor).

### JSSpeccy 3 mobile mod

Source: https://github.com/dcrespo3d/jsspeccy3-mobile

Designed for mobile browsers with per-game customizable soft keys.

Configured using URL parameters.

#### Example URL

https://code.zxplay.org/?k=-W-P,ASDe,123456789M&m=48&u=https://davidprograma.github.io/ytc/09-ZxSpectrum/snake-1.01.tap

The URL can be decomposed in these parts:

- Main part:

```
https://code.zxplay.org/
```

- Soft keys:

```
?k=-W-P,ASDe,123456789M
```

- Machine type (48, 128, 5 for pentagon)

```
&m=48
```

- Program/game URL to load:

```
&u=https://davidprograma.github.io/ytc/09-ZxSpectrum/snake-1.01.tap
```

You can build your own URL setting soft keys, machine type (defaults to 48) and a
URL (\*) for a Z80, SNA, SZX, TZX or TAP file containing the desired game or program.

(\*) Target URL **must** be hosted in a website with CORS enabled.

- Optional filtering (default 0 is not filtered, good old pixels):

```
&f=1
```

#### Soft key syntax

The syntax is simple: keys are arranged as rows, and rows are separated by commas.
So, the previous strings has 3 rows:

```
-W-P
ASDe
123456789M
```

A key is defined by its UPPERCASE character, and a hyphen (-) means a blank.

The exceptions are:

- Enter key: e (lowercase e)
- Caps shift: c (lowercase c)
- Symbol shift: s (lowercase s)
- Space: \_ (underscore)

### Palette mod

Source: https://github.com/cronomantic/jsspeccy3

The RGB values described [here](https://en.wikipedia.org/wiki/ZX_Spectrum_graphic_modes#Colour_palette)
are most likely calculated by measuring voltages on the RGB output of the 128k models, since the ULAs of
those systems generate RGBI signals that later are encoded to composite by the TEA2000 IC.
Those are the colors that most emulators use and most people are used to.

### Tech notes

#### Architecture

The browser UI thread (starting point in runtime/jsspeccy.js) is kept as lightweight
as possible, only performing tasks that are directly related to communication with
the "outside world": rendering the screen data to a canvas, handling keyboard events,
outputting audio and managing UI actions such as loading files.

All the actual emulation happens inside a Web Worker (runtime/worker.js), with all
communcation between the UI thread and the worker happening through `postMessage`.
The most important messages are `runFrame` (sent from the UI thread to the worker,
to tell it to run one frame of emulation and fill the passed video and audio buffers
with the resulting output) and `frameCompleted` (sent from the worker to the UI thread
when execution of the frame is complete, passing the filled video and audio buffers back).

Within the Web Worker, all of the performance-critical work is handled by a WebAssembly
module (jsspeccy-core.wasm). The main entry point into this is the `runFrame` function,
which runs the Z80 and all related 'continuous' processes (memory reads / writes,
responding to port reads / writes, building the screen and generating audio) for one
video frame. `runFrame` returns a status of 1 to indicate that the frame has completed
execution (and thus the video / audio buffers are ready to send back to the UI thread),
with other status values serving as 'exceptions', indicating that execution was
interrupted and needs action from the calling code before it can be continued (by
calling `resumeFrame`). At the time of writing, the only kind of exception implemented
is a tape loading trap.

All state required for the WebAssembly core module to run - including memory
contents (ROM and RAM), registers, audio / video buffers and lookup tables - is
contained within the module's own memory map, and statically allocated at compile time.

On the real machine, generating video and audio output happens in parallel with
the Z80's execution - an emulator implementing this naïvely would have to break
out of the Z80 loop every few cycles to perform these tasks. In fact, these
processes can be deferred for as long as we like, as long as we catch up on them
before any state changes occur that would affect the output. With this in mind,
the JSSpeccy core implements two functions `updateFramebuffer` and `updateAudioBuffer`
which perform all pending video / audio generation as far as the current Z80 cycle.
These are called immediately before any state change (which means, for audio, a
write to any AY register or the beeper port; and for video, a write to video memory,
change of border colour or a write to the memory paging port).

#### Building the core

To build jsspeccy-core.wasm, we run the script generator/gencore.mjs, which runs
a preprocessing pass over the input file generator/core.ts.in, to generate the
[AssemblyScript](https://www.assemblyscript.org/) source file build/core.ts. This
is then passed to the AssemblyScript compiler to produce the final dist/jsspeccy-core.wasm module.

The preprocessor step serves two purposes: firstly, it allows us to programmatically
build the large repetitive `switch` statements that form the Z80 core. Secondly,
it allows us to use conventional array syntax to access our statically-defined arrays.
Currently, AssemblyScript does not appear to have any native support for static
arrays - any use of array syntax causes it to immediately pull in a `malloc`
implementation and a higher-level array construct with bounds checking, all of which
is unwanted overhead for our purposes. The gencore.mjs processor rewrites array
syntax into direct memory access [`load` / `store` instructions](https://www.assemblyscript.org/stdlib/builtins.html#memory).

All statically-defined arrays are allocated at the start of the module's memory map,
from address 0 onward. Currently a 512Kb block is allocated for these - if you need
more, increase `memoryBase` in asconfig.json.

The gencore.mjs preprocessor recognises the following directives:

- `#alloc` - allocates an array of the given size and type. For example, if `#alloc frameBuffer[0x6600]: u8` is the first line of the file, then 0x6600 bytes from address 0 will be allocated to an array named `frameBuffer`. This will then rewrite subsequent lines as follows:
  - An assignment such as `frameBuffer = [0x00, 0x01, 0x02];` will be rewritten as a sequence of `store<u8>(0, 0x00);`, `store<u8>(1, 0x01);` lines
  - An assignment such as `frameBuffer[ptr] = 0x00;` will be rewritten as `store<u8>(0 + ptr, 0x00);`
  - A lookup such as `val = frameBuffer[ptr];` will be rewritten as `val = load<u8>(0 + ptr);`
  - `(&frameBuffer)` will be replaced with the array's base address, e.g. `const FRAME_BUFFER = (&frameBuffer);` becomes `const FRAME_BUFFER = 0;`
  - Keep in mind that these are simple regexp replacements, not a full parser - it's likely to fail on statements that are split over multiple lines, or have nested brackets. If you don't like this, feel free to submit a better implementation of static arrays to the AssemblyScript project :-)
- `#const` - defines an identifier to be replaced by the given expression. For example, given a directive `#const FLAG_C 0x01`, a subsequent line `result &= FLAG_C;` will be rewritten to `result &= 0x01;`. `const FLAG_C = 0x01;` would achieve the same thing, but will also define a symbol in the resulting module, which we probably don't want.
- `#regpair` - allocates two bytes to store a Z80 register pair. This is always little-endian, as per the WebAssembly spec. For example, if the next memory address to be allocated is 0x1000, then `#regpair BC B C` will define identifiers `BC`, `B` and `C` such that:
  - `val = BC;` is rewritten to `val = load<u16>(0x1000);`
  - `BC = 0x1234;` is rewritten to `store<u16>(0x1000, 0x1234);`
  - `val = B;` is rewritten to `val = load<u8>(0x1001);`
  - `B = result;` is rewritten to `store<u8>(0x1001, result);`
  - `val = C;` is rewritten to `val = load<u8>(0x1000);`
  - `C = result;` is rewritten to `store<u8>(0x1000, result);`
- `#optable` - generates the sequence of `case` statements that decode an opcode byte. The subroutine bodies for each class of instruction are defined in generator/instructions.mjs, and these are pattern-matched to the actual instruction lists in generator/opcodes\_\*.txt.

#### Frame buffer format

The frame buffer data structure (as written by the WebAssembly core and passed to
the UI thread in the `frameCompleted` message) is essentially a log of all border,
screen and attribute bytes in the order that they would be read to build the video
output. This is based on a 320x240 output image consisting of 24 lines of upper
border, 192 lines of main screen (each consisting of 32px left border, 256px main
screen, and 32px right border), and 24 lines of lower border. This results in a
0x6600 byte buffer, breaking down as follows:

- 0x0000..0x009f: line 0 of the upper border. 160 bytes, each one being a border colour (0..7) and contributing two pixels to the final image. (This corresponds to the maximum resolution at which border colour changes happen on the Pentagon; these take effect on every cycle, and one cycle equals two pixels.)
- 0x00a0..0x013f: line 1 of the upper border
- ...
- 0x0e60..0x0eff: line 23 of the upper border
- 0x0f00..0x0f0f: left border of main screen line 0. 16 bytes, each contributing two pixels of border as before
- 0x0f10..0x0f4f: main screen line 0. 32\*2 bytes, consisting of the pixel byte and attribute byte for each of the 32 character cells
- 0x0f50..0x0f5f: right border of main screen line 0. 16 bytes, each contributing two pixels of border as before
- 0x0f60..0x0f6f: left border of main screen line 1
- 0x0f70..0x0faf: main screen line 1. (Again, since the data here is in the order that the video output would be generated, this is the data pulled from address 0x4100 onward, not 0x4020.)
- 0x0fb0..0x0fbf: right border of main screen line 2
- ...
- 0x56a0..0x56af: left border of main screen line 191
- 0x56b0..0x56ef: main screen line 191
- 0x56f0..0x56ff: right border of main screen line 191
- 0x5700..0x579f: line 0 of the lower border. 160 bytes, as per upper border
- 0x57a0..0x583f: line 1 of the lower border
- ...
- 0x6560..0x65ff: line 23 of the lower border

## Acknowledgements

This software uses code from the following open source projects:

- JSSpeccy3 & JSSpeccy3-mobile. These are licensed under terms of the GPL version 3.
- Pasmo by Julián Albo García, alias "NotFound". Licensed under terms of the GPL version 3.
- Boriel ZX BASIC by Jose Rodriguez. Licensed under terms of the GPL version 3.
- zmakebas by Russell Marks. This tool is public domain.
- 8bitworkshop by Steven Hugg. Licensed under terms of the GPL version 3.
