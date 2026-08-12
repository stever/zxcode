# ZX Play documentation

ZX Play is three things built on one emulation core:

- **[zxplay.org](https://zxplay.org)** — a mobile-friendly ZX Spectrum player.
  Open a program and play it, on a phone or a desktop.
- **[code.zxplay.org](https://code.zxplay.org)** — a browser IDE for Spectrum
  and Spectrum Next development. Eleven toolchains compile in the browser or on
  the server, and the result runs immediately in an emulator that sits beside
  the editor, with source-line breakpoints.
- **[zxplay_go](emulator.html)** — the emulator itself: a Go emulator for the
  whole Sinclair 8-bit line and a from-the-silicon-up Spectrum Next. It runs
  as a desktop application, as WebAssembly inside the two sites, and as a
  scriptable headless harness you can point at your own game.

All three come out of one repository,
[stever/zxcode](https://github.com/stever/zxcode).

## Which part do you want?

**I want to write a Spectrum or Next program without installing anything.**
Start with [Using the IDE](ide.html), then pick a toolchain from
[Languages and toolchains](languages.html).

**I am developing a game locally and want the emulator in my build loop.**
[Automating the emulator](automation.html) is the page to read: headless
runs, scripted breakpoints, screenshots, and regression tests that fail your
build when the game breaks.

**I use DeZog / ZEsarUX / CSpect and want to know how zxplay_go fits.**
Read [DeZog, ZEsarUX and CSpect](debug-protocols.html) first. The short
version: zxplay_go speaks its own line-oriented protocol, DeZog cannot attach
to it, and the page explains what to use instead and where each tool wins.

**I want to know whether my game will run correctly.**
[Game compatibility](compatibility.html) lists tested titles and their
status; the [conformance dashboard](conformance.html) shows the emulator's
live standing against its oracles and the external Next test suites; and
[known gaps](known-gaps.html) records the deliberate differences from real
hardware.

**I want to change the emulator.**
Read the [architecture docs](architecture.html) before anything else, then
[Contributing](contributing.html).

## Honest status

The classic line — ZX80, ZX81, Spectrum 48K/128K/+2/+2A/+3, Pentagon, SAM
Coupé — is mature: cycle-accurate, contended, and stable enough for
day-to-day work.

The Spectrum Next **boots real NextZXOS through the authentic FPGA chain**
and its individual hardware blocks are extensively tested against the FPGA
VHDL, but **running arbitrary `.nex` games is the newest and least-finished
area**. Some titles are playable, several render with bugs, and many are
unverified. If a Next game misbehaves, that is expected at this stage —
[open an issue](https://github.com/stever/zxcode/issues), because a
comparison against real hardware is exactly what moves it forward.
