# Real-hardware debugging: driving a ZX Spectrum Next over serial

`dzrp.py` is a standalone DZRP client that debugs a REAL Spectrum Next
from a shell — no VS Code, no DeZog extension. It loads .nex programs
over the wire, patches breakpoints, waits for hits, and reads
registers, memory, ports and NextRegs. Fully scriptable, which makes
it the silicon ground-truth oracle for conformance questions the
VHDL alone can't settle (first proven on TX-1696 / work item #169,
2026-07-16, where a single session found a root cause that two days
of VHDL geometry analysis had missed).

This complements the two zx_go debuggers (see ../DEBUGGER.md): same
methodology — breakpoint, inspect, compare — but the target is the
real machine, so emulator-vs-silicon A/B runs use the same probe
addresses on both sides.

## Hardware setup

- **dezogif** (the DeZog Next stub, github.com/maziac/dezogif)
  installed on the SD card as `machines/next/enNextMf.rom`
  (replaces the Multiface ROM — keep a backup). Supports core
  3.01.10 / 3.02.00.
- A 921600-baud-capable USB-TTL serial cable to the **Joy 2** DB9:
  cable RXD → pin 7 (Next TX), GND → pin 8, cable TXD → pin 9
  (Next RX). Nothing else wired.
- Arming, every session/power-cycle: boot NextZXOS fully, navigate
  the Browser INTO the directory the program expects as its CWD
  (file-relative loads resolve against it), then press the yellow
  NMI button once (dezogif takes over, colour-cycling border).
- PC side: `/dev/ttyUSB0` readable (dialout group or chmod).

## Usage

```bash
python3 dzrp.py init                 # handshake (prints dezogif version)
python3 dzrp.py regs                 # registers + MMU slots
python3 dzrp.py md 0xB168 12         # memory hex dump
python3 dzrp.py loadnex game.nex     # parse + transfer + set SP/PC (paused)
python3 dzrp.py cont                 # start/resume
python3 dzrp.py sniff                # wait for/print pause notifications
python3 dzrp.py sizetest             # link health check (escalating writes)
```

`campaign` / `campaign-resume` are a worked example (the TX-1696
session): load, breakpoint an always-hit address to prove the
machinery, re-arm onto the question address, wait. Copy that shape
for new investigations. Every wire frame is hex-logged to `dzrp.log`.

## Protocol facts (learned the hard way — trust these over the spec)

Verified against dezogif v2.2.1 (DZRP 2.1.0) source and live use:

- Frame: `[len u32 LE][seq u8][cmd u8][payload]`. **len counts the
  payload ONLY** (not seq/cmd) — matches DeZog's sender, not every
  reading of the spec.
- dezogif prefixes messages **it sends** with a `0xA5` leader (the
  joy port idles with zeros); frames you send take no leader.
- Responses: `[0xA5][len u32][seq][payload]` where len = 1+payload.
  Notifications have seq=0; NTF_PAUSE payload =
  `[1][reason][addr u16][bank+1][0]` (reason 2 = breakpoint).
- `CMD_CONTINUE` payload is exactly **11 bytes**: bp1 enable(1) +
  addr(2), bp2 enable(1) + addr(2), alt-cmd(1), range start(2) +
  end(2). Wrong sizes stall dezogif into its 100 ms per-byte timeout
  (it shows a timeout error on the Next but recovers to the command
  loop; your NEXT frame may be eaten by the drain — just retry).
- Large writes: the fd must handle **partial writes** (8K bank
  frames overflow the tty buffer; an unhandled short write stalls
  the stream and trips the same dezogif timeout).
- .nex bank storage order is the permutation **5,2,0,1,3,4,6,7,…**;
  each 16K bank goes over as two 8K `CMD_WRITE_BANK`s (banks
  2n/2n+1). 8K bank **94 is reserved** by dezogif (MAIN_BANK).
- Load sequence (mirrors DeZog): set border, write banks, set slots
  `[ROM,ROM,10,11,4,5,entry*2,entry*2+1]`, set SP then PC
  (`CMD_SET_REGISTER`: reg 1 = SP, reg 0 = PC), first
  `CMD_CONTINUE` starts the program.
- Useful extras dezogif implements: `CMD_GET_TBBLUE_REG` (11),
  `CMD_READ/WRITE_PORT` (20/21), `CMD_EXEC_ASM` (22, ≤100 bytes),
  `CMD_INTERRUPT_ON_OFF` (23).

## Constraints and safety

- **No host-initiated pause.** While the program runs, dezogif is
  not listening; only a patched breakpoint (RST 0) or the yellow
  button stops it. Plan every run as: set breakpoints while paused →
  continue → wait.
- The yellow button is dead while a program has Layer 2 read/write
  paging over the low 16K (dezogif needs $0000-$1FFF) — true for
  TX-1696 and likely other L2-heavy games. Breakpoints still work.
- Breakpoints consume ~8 bytes of the debuggee's stack when they
  fire. Do NOT breakpoint code that runs with SP inside the
  $2000-$3FFF ROM window (writes are discarded there) or other
  degenerate stack states — the handler's pushes vanish and the
  machine wrecks instead of pausing.
- Raster-phased / timing-critical code: place breakpoints BEFORE a
  re-synchronising point (e.g. ahead of a raster poll) or AFTER the
  critical window, never inside it — the pause itself changes what
  you are measuring.
- NextReg/port reads happen at pause time, milliseconds after the
  hit — raster-position style values are meaningless by then.
- A crashed run needs a human: power-cycle, re-navigate to the CWD,
  press the yellow button. Runs that end at breakpoints can chain
  hands-free.
