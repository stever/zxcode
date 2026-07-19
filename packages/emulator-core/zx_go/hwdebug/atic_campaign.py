#!/usr/bin/env python3
"""Atic Atac scene-transition campaign (work item #187).

Question for the silicon: how does the game sequence its ~20 kHz
copper-paced divMMC-NMI sample streamer across scene transitions
(title -> cinematic -> menu -> doors)? In the emulator the streamer
never restarts after a transition and the main thread consumes a
stale jump vector; on hardware it works. Capture the ordering.

Plan (all addresses from the emulator's staging probe):
  1. loadnex ATICATAC.NEX (code banks only; the 111 MB stays on card).
  2. Plant a one-shot anchor bp at $E25A (JP $DAC0 — the stage-2
     loader's single handoff into the staged engine; lives in 8k bank
     1 which loadnex transfers, so it is patchable pre-start via a
     slot remap). Fires ~4 s in, after ALL engine code is staged and
     before any of it runs.
  3. At the anchor: restore, then plant the scene-init bp $C951
     (8k bank 6, mapped at slot 6 during play) and continue.
  4. Each $C951 hit = a scene transition seeding the countdown.
     Dump regs, NR$06, port $E3, the $F980-$F9FF engine block, and
     re-arm. The operator advances scenes (fire/space).
  5. After the operator selects a character (menu -> doors), switch
     to streamer logging: alternate bps $D1ED/$D1DD (CMD12/CMD18
     issue points) so each pause stands on a restored byte while the
     partner bp catches the next command. Log ~30 commands with args.

Usage: atic_campaign.py [--port /dev/ttyUSB0] [--transitions N]
"""

import struct
import sys
import time

import dzrp
from dzrp import (CMD_GET_REGISTERS, CMD_SET_REGISTER, Link, load_nex,
                  parse_registers, read_mem, restore_bps, set_bps,
                  cont_run, wait_pause)

NEX = "/home/steve/Downloads/ZX Spectrum Next/Atic Atac/ATICATAC.NEX"

CMD_SET_SLOT = 10
CMD_GET_TBBLUE_REG = 11
CMD_READ_PORT = 20

ANCHOR = 0xE25A      # loader->engine handoff (JP $DAC0), 8k bank 1
ANCHOR_BANK8 = 1
SCENE_INIT = 0xC951  # countdown seeder, runs once per scene transition
CMD18_PC = 0xD1DD    # streamer CMD18 (start multi-block read) issue
CMD12_PC = 0xD1ED    # streamer CMD12 (stop transmission) issue


def rd_nextreg(link, reg):
    v = link.request(CMD_GET_TBBLUE_REG, bytes([reg]))
    return v[-1]


def rd_port(link, port):
    v = link.request(CMD_READ_PORT, struct.pack("<H", port))
    return v[-1]


def dump_transition(link, label):
    print("=== %s ===" % label)
    print(parse_registers(link.request(CMD_GET_REGISTERS)))
    nr06 = rd_nextreg(link, 0x06)
    e3 = rd_port(link, 0xE3)
    print("NR$06=$%02X  portE3=$%02X" % (nr06, e3))
    blk = read_mem(link, 0xF980, 0x80)
    for o in range(0, 0x80, 16):
        print("F9%02X: %s" % (0x80 + o, blk[o:o + 16].hex(" ")))


def main():
    args = sys.argv[1:]
    port = "/dev/ttyUSB0"
    if args and args[0] == "--port":
        port = args[1]
        args = args[2:]
    transitions = 6
    if args and args[0] == "--transitions":
        transitions = int(args[1])
        args = args[2:]

    link = Link(port)
    link.request(dzrp.CMD_INIT, bytes([2, 0, 0]) + b"zx_go-probe\x00")
    load_nex(link, NEX)

    # Anchor bp into 8k bank 1 via a temporary slot-7 remap (at load
    # time slot 7 holds bank 5; the loader runs with bank 1 there).
    link.request(CMD_SET_SLOT, bytes([7, ANCHOR_BANK8]))
    bps = set_bps(link, [ANCHOR])
    link.request(CMD_SET_SLOT, bytes([7, 5]))
    print("anchor bp $%04X planted in bank8 %d (orig %02X); starting"
          % (ANCHOR, ANCHOR_BANK8, bps[0][1]))
    cont_run(link)
    hit = wait_pause(link, 60)
    if hit is None:
        print("anchor never hit — abort (machine state unknown)")
        return 1
    print("anchor hit at $%04X — engine staged" % hit[1])
    # Slot 7 already holds bank 1 here (loader mapping) — logical
    # restore lands in the right bank.
    restore_bps(link, bps)

    # Sanity: the scene-init and streamer bytes must be staged now.
    # Slot 6 holds 8k bank 0 at this pause; the engine lives in bank 6.
    link.request(CMD_SET_SLOT, bytes([6, 6]))
    probe = read_mem(link, 0xC940, 32) + read_mem(link, 0xD1D0, 48)
    print("engine probe C940:", probe[:32].hex(" "))
    print("engine probe D1D0:", probe[32:].hex(" "))
    scene_bps = set_bps(link, [SCENE_INIT])
    link.request(CMD_SET_SLOT, bytes([6, 0]))
    print("scene bp $%04X armed (orig %02X); continuing — let the game "
          "run, advance scenes with fire/space" % (SCENE_INIT, scene_bps[0][1]))
    cont_run(link)

    for n in range(transitions):
        hit = wait_pause(link, 600)
        if hit is None:
            print("no scene transition within 600s — leaving machine running")
            return 0
        dump_transition(link, "scene-init hit %d (pc=$%04X)" % (n + 1, hit[1]))
        if n + 1 < transitions:
            # Re-arm: we are paused ON $C951 with the byte still
            # patched; restore it, then use the CONTINUE payload's
            # temporary bp on the NEXT address to re-patch after
            # stepping... simpler: restore, arm nothing this pass,
            # and re-patch $C951 from the NEXT streamer pause is
            # complex — instead restore + immediately re-set: the
            # RST-patched byte was never executed (dezogif rewinds
            # PC), so restore then re-arm the SAME address works if
            # we first single-hop past it via a temp bp at $C954
            # (the next instruction; $C951 is a 3-byte store).
            restore_bps(link, scene_bps)
            hop = set_bps(link, [0xC954])
            cont_run(link)
            h2 = wait_pause(link, 30)
            restore_bps(link, hop)
            if h2 is None:
                print("hop past $C951 failed; leaving running unarmed")
                return 0
            scene_bps = set_bps(link, [SCENE_INIT])
            cont_run(link)
    print("transition budget used; machine left paused at last hit.")
    print("run streamer phase: atic_streamer.py (or 'cont' to resume)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
