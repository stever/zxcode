# zx_go architecture documentation

Developer documentation for the zx_go emulation core. It covers the
architecture, the code organisation, the implementation patterns, how the
real chips are emulated, how the Spectrum Next FPGA emulation works, and
the known gaps against real hardware.

The audience is both people and agents. If you are an AI agent working in
this repository, read the [maintenance rules](#maintaining-this-documentation)
below: this documentation is part of the change surface, not an artifact.

## Contents

| Document | What it covers |
| --- | --- |
| [overview.md](overview.md) | High-level architecture: machines, surfaces, the frame loop, the fidelity philosophy. Start here. |
| [code-organisation.md](code-organisation.md) | Package-by-package map: responsibilities, key types, key files, build system. |
| [emulation-patterns.md](emulation-patterns.md) | The recurring implementation patterns: VHDL transcription, golden-vector tests, hook wiring, timing models, event-timed audio. |
| [chips.md](chips.md) | Every real chip (and chip-equivalent) that is emulated, where it lives, and which emulation style it uses. |
| [next-fpga.md](next-fpga.md) | The Spectrum Next FPGA emulation in depth: NextRegs, wiring, video layers, Copper, DMA, interrupts, boot chain, storage. |
| [frontends.md](frontends.md) | The three surfaces (desktop, headless, browser wasm), pacing, the debugger backend, the test harness, builds. |
| [known-gaps.md](known-gaps.md) | Known gaps and simplifications against real hardware, with sources, and how gaps get closed. |

## Diagrams

The diagrams are Draw.io files in [diagrams/](diagrams/). Edit them with
[app.diagrams.net](https://app.diagrams.net), the draw.io desktop app, or
the VS Code Draw.io extension. Keep them in sync with the text.

| Diagram | Shows |
| --- | --- |
| [system-overview.drawio](diagrams/system-overview.drawio) | Surfaces, core packages, machine stacks, support packages, and how they connect. |
| [frame-loop.drawio](diagrams/frame-loop.drawio) | One emulated frame, plus desktop vs browser pacing. |
| [memory-decode.drawio](diagrams/memory-decode.drawio) | The Next memory-read priority mux and the classic paging registers. |
| [next-video-pipeline.drawio](diagrams/next-video-pipeline.drawio) | Copper step, layer scanline renderers, palettes, compositor, wide paths. |
| [next-boot-chain.drawio](diagrams/next-boot-chain.drawio) | Faithful cold boot, the browser direct-boot and fastboot accelerators, SD delivery. |
| [wasm-integration.drawio](diagrams/wasm-integration.drawio) | GoEmulator.js, the wasm export surface, and the Go core on the browser main thread. |
| [debugger-surfaces.drawio](diagrams/debugger-surfaces.drawio) | Three debugger surfaces over one shared backend. |

## Getting up to speed quickly

Suggested reading order for a first session on this codebase:

1. [overview.md](overview.md) with
   [system-overview.drawio](diagrams/system-overview.drawio) open.
2. [frame-loop.drawio](diagrams/frame-loop.drawio), then skim the
   `ExecuteFrame` body in `pkg/z80/z80.go` and `Render` in `pkg/ula/ula.go`.
3. [emulation-patterns.md](emulation-patterns.md). The patterns repeat
   everywhere, so this pays off fastest.
4. The doc for your area: [chips.md](chips.md) for classic hardware,
   [next-fpga.md](next-fpga.md) for anything Next,
   [frontends.md](frontends.md) for the GUI, headless, wasm, or debugger.
5. Before changing behaviour, check [known-gaps.md](known-gaps.md) and
   `ROADMAP.md` (repo root): the gap may be catalogued with a decision
   attached.

Related documents outside this folder:

- `../../conformance/` — the conformance dashboard: manifest + generator
  publishing live pass/gap status to GitHub Pages
  (https://stever.dev/zxcode/). Its inputs are the manifest, the
  real test run, and [known-gaps.md](known-gaps.md).
- `../../README.md` — user-facing project README.
- `../../ROADMAP.md` — current state, backlog, hardware-feature catalogue,
  do-not-regress invariants.
- `../../VHDL_CONFORMANCE.md` — the VHDL-to-emulator conformance matrix
  for the Next core.
- `../../DEBUGGER.md` — the full debugger user reference.
- `../../CONTRIBUTING.md` — dev loop, conventions, how to add tests and
  NextReg handlers.
- `../manual.md`, `../spectrum-next.md`, `../compatibility.md`,
  `../zx80-zx81.md`, `../sam-coupe.md` — user-facing docs.
- `../../../wasm/STATUS.md` — the wasm port design notes
  (packages/emulator-core/wasm).

## Maintaining this documentation

These rules apply to everyone who changes the emulator, human or agent.

- Documentation updates ship in the same change as the code they
  describe. A change that alters architecture, adds or removes a package,
  changes a wire-up, adds a wasm export, or closes/opens a hardware gap
  is incomplete without the matching doc and diagram update.
- Update map. When you touch:
  - a package's responsibilities or public shape →
    [code-organisation.md](code-organisation.md) and
    [system-overview.drawio](diagrams/system-overview.drawio)
  - the frame loop, pacing, interrupts, or audio flow →
    [overview.md](overview.md) and
    [frame-loop.drawio](diagrams/frame-loop.drawio)
  - memory decode order, paging, MMU →
    [next-fpga.md](next-fpga.md) and
    [memory-decode.drawio](diagrams/memory-decode.drawio)
  - Next video layers, compositor, Copper →
    [next-fpga.md](next-fpga.md) and
    [next-video-pipeline.drawio](diagrams/next-video-pipeline.drawio)
  - the boot chain, NR$02/NR$03, direct boot, fastboot →
    [next-fpga.md](next-fpga.md) and
    [next-boot-chain.drawio](diagrams/next-boot-chain.drawio)
  - wasm exports or GoEmulator.js contract →
    [frontends.md](frontends.md) and
    [wasm-integration.drawio](diagrams/wasm-integration.drawio)
  - debugger commands or breakpoint mechanisms →
    [frontends.md](frontends.md) and
    [debugger-surfaces.drawio](diagrams/debugger-surfaces.drawio)
  - closing a known gap, or accepting a new simplification →
    [known-gaps.md](known-gaps.md), and `ROADMAP.md` if it is catalogued
    there
  - renaming or adding a conformance/golden test, or integrating an
    external test suite → `conformance/manifest.json` (the published
    dashboard resolves statuses by exact package + test name)
  - a new chip or a new emulation style → [chips.md](chips.md) and
    [emulation-patterns.md](emulation-patterns.md)
- Line numbers drift. Prefer symbol names (types, functions, NextReg
  numbers, VHDL entity names) over line numbers in these docs. When a
  line number adds real value, mark it approximate.
- Keep claims sourced. Fidelity statements should trace to the oracle
  (zxnext.vhd line, FUSE, Sean Young, a golden test) the same way the
  code comments do. Do not soften or inflate the status of a feature:
  copy the honest wording used by `ROADMAP.md`.
- Diagrams stay small. Prefer editing an existing diagram over adding a
  near-duplicate. If a diagram grows past roughly 30 nodes, split it.
- The initiative for this documentation is tracked in Wolfpack (ZX Play
  roadmap item #r2); `ROADMAP.md` carries a pointer under "Initiative:
  architecture documentation". Record substantial doc work against the
  Wolfpack initiative.
