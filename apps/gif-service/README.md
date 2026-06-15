# gif-service

Generates an animated GIF from a ZX Spectrum `.tap` file. It loads the tape in
a headless JSSpeccy3 WASM core, runs the program, and encodes the frames.

## Run the service

```bash
# from apps/gif-service/
PORT=5001 npx tsx src/index.ts
```

Health check:

```bash
curl localhost:5001/health
```

## Generate a GIF

POST the tape file as multipart form field `tape`:

```bash
curl -X POST -F "tape=@lonewolf.tap" \
  "http://localhost:5001/api/tape-to-gif?maxSeconds=30" -o lonewolf.gif
```

### Query parameters

| Param            | Default | Meaning                                                        |
| ---------------- | ------- | -------------------------------------------------------------- |
| `maxSeconds`     | `30`    | Cap on captured run length.                                    |
| `staleThreshold` | `150`   | Consecutive identical frames before the program is considered finished. |
| `machineType`    | `128`   | Spectrum model. Only `128` is supported (see Limitations).     |

## How loading works

The 128K machine boots to its start-up menu with "Tape Loader" pre-selected, so
the service presses ENTER to run `LOAD ""`. Tape traps are enabled, so standard
ROM blocks load instantly without playing tape audio.

## Limitations

Works for standard, self-running programs. It does not handle:

- Custom or turbo loaders (most commercial multiload games). The trap fires only
  on the ROM loader, so a game that reads the tape port itself stalls. Example:
  `lonewolf.tap` loads its title screen, then hangs waiting for blocks the
  service does not feed.
- Programs that wait for keyboard or joystick input (no input is injected during
  the run).
- Non-auto-running tapes, which load and drop back to BASIC without running.
- 48K machines (the boot/menu flow assumes the 128K start-up menu).
