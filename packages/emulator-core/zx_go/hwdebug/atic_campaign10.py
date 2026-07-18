# campaign6: skip-window capture (#187 r66).
# Goal: the hardware interleaving of the fire-skip transition —
#   (a) does the per-frame $F990 countdown keep ticking through the skip,
#   (b) when the $D107/$D131 menu load starts relative to the jingle chain
#       ($21 track -> countdown expiry -> track $00/flags $C0),
#   (c) does the engine still tick at the menu ($F990/$F9E3 sampling).
# Track anchor stays PERMANENTLY armed; every hit is timestamped and
# resumed fast (light reads only). After 25 s of quiet, CMD_PAUSE
# sampling passes probe menu-era engine liveness.
import sys, struct, time
sys.path.insert(0, "/home/steve/Git/github.com/stever/zxcode/packages/emulator-core/zx_go/hwdebug")
import dzrp
from dzrp import Link, load_nex, parse_registers, read_mem, cont_run, wait_pause

SCRATCH = "/tmp/claude-1000/-home-steve-Git-github-com-stever-zxcode/e23feb7a-470c-419f-9090-538ae4c2a116/scratchpad"
EXIT_STUB = bytes([0x18,0x64, 0xFB, 0xED,0x92,0x57, 0xF1, 0xC9])

def synth_entry(report_pc):
    return bytes([
        0x01,0x3B,0x24, 0x3E,0x50, 0xED,0x79, 0x04, 0xED,0x78, 0x4F,
        0x21,report_pc & 0xFF,report_pc >> 8, 0xE5,
        0xF5,                       # PUSH AF — the contract's ORIGINAL-AF slot
        0xED,0x57, 0xF5, 0xED,0x57, 0xF3, 0xC5,
        0xED,0x91,0x50,94, 0xC3,0x74,0x00,
    ])

QUIESCE_PREFIX = bytes([
    0x01,0x3B,0x24,      # LD BC,$243B
    0x3E,0x62, 0xED,0x79,# select NR$62
    0x04, 0xED,0x78,     # BC=$253B; IN A,(C) — read NR$62
    0x32,0xF0,0x7F,      # LD ($7FF0),A — save (slot3=bank94 here)
    0x3E,0x00, 0xED,0x79,# NR$62 <- 0 — copper stopped
])

def anchor_stub(report_pc):
    return QUIESCE_PREFIX + synth_entry(report_pc)

ANCHOR_TRACK = bytes([0xED,0x91,0x53,94, 0xC3,0x00,0x7F])  # -> stub bank94:$1F00
ANCHOR_D131  = bytes([0xED,0x91,0x53,94, 0xC3,0x40,0x7F])  # -> stub bank94:$1F40

link = Link("/dev/ttyUSB1")
link.request(dzrp.CMD_INIT, bytes([2, 0, 0]) + b"zx_go-probe\x00")   # once only
T0 = time.monotonic()
def ts(): return time.monotonic() - T0

def wmem(addr, data):
    link.request(dzrp.CMD_WRITE_MEM, struct.pack("<BH", 0, addr) + data)

def regs_raw():
    return parse_registers(link.request(dzrp.CMD_GET_REGISTERS))

def slots_list(r=None):
    return [int(x) for x in (r or regs_raw()).split("slots=")[1].split(",")]

def reg16(r, name):
    return int(r.split(name + "=$")[1][:4], 16)

def set_slot(slot, bank):
    link.request(10, bytes([slot, bank]))

def rd_nr(reg):
    return link.request(11, bytes([reg]))[-1]

def wr_nr(reg, val):
    link.request(21, struct.pack("<HB", 0x243B, reg))
    link.request(21, struct.pack("<HB", 0x253B, val))

def set_pc(pc): link.request(dzrp.CMD_SET_REGISTER, struct.pack("<BH", 0, pc))

def exit_stub_into(bank, scratch_restore):
    set_slot(3, bank)
    wmem(0x6000, EXIT_STUB)
    ok = read_mem(link, 0x6000, 8) == EXIT_STUB
    set_slot(3, scratch_restore)
    return ok

def engine_state():
    a = read_mem(link, 0xF990, 8)    # F990 cnt / F992 seed / F994 flags / F995 track / F996 event
    b = read_mem(link, 0xF9E0, 8)    # F9E3/F9E4 position word
    return ("F990=%02X F992=%04X flags=%02X trk=%02X ev=%02X pos=%02X%02X"
            % (a[0], a[2] | a[3] << 8, a[4], a[5], a[6], b[4], b[3]))

# ---------- stage 0: load + plant everything (proven campaign5 route) ----------
load_nex(link, "/home/steve/Downloads/ZX Spectrum Next/Atic Atac/ATICATAC.NEX")
set_slot(3, 94)
wmem(0x7F00, anchor_stub(0xC949))
wmem(0x7F40, anchor_stub(0xD131))
stub_a, stub_b = anchor_stub(0xC949), anchor_stub(0xD131)
ok = (read_mem(link, 0x7F00, len(stub_a)) == stub_a
      and read_mem(link, 0x7F40, len(stub_b)) == stub_b)
set_slot(3, 11)
if not ok: print("ABORT bank94 stubs"); sys.exit(1)
print("bank94 stubs planted")
set_slot(7, 1)
wmem(0xEE00, synth_entry(0xE25A))
stub_h = synth_entry(0xE25A)
if read_mem(link, 0xEE00, len(stub_h)) != stub_h: print("ABORT ee00"); sys.exit(1)
if read_mem(link, 0xE25A, 3) != bytes([0xC3,0xC0,0xDA]): print("ABORT e25a"); sys.exit(1)
wmem(0xE25A, bytes([0xC3,0x00,0xEE]))
set_slot(6, 4); set_slot(7, 5)
cont_run(link)
print("started; awaiting handoff pause")
if wait_pause(link, 60) is None: print("NO HANDOFF PAUSE"); sys.exit(1)
r = regs_raw(); sl = slots_list(r)
print("[%7.2fs] handoff pause; slots: %s" % (ts(), sl))
nr62 = rd_nr(0x62); wr_nr(0x62, 0)
wmem(0xE25A, bytes([0xC3,0xC0,0xDA]))
exit_stub_into(sl[0], sl[3])
exit_stub_into(16, sl[3])
set_slot(6, 6)
orig_c949 = read_mem(link, 0xC949, 7)
print("orig $C949:", orig_c949.hex(" "))
wmem(0xC949, ANCHOR_TRACK)
ok = read_mem(link, 0xC949, 7) == ANCHOR_TRACK
set_slot(6, sl[6])
if not ok: print("ABORT anchor"); sys.exit(1)
print("track_start anchor armed at $C949 (permanent)")
wr_nr(0x62, nr62)
set_pc(0xE25A)
cont_run(link)
print()
print(">>> Let the title tune start, then PRESS FIRE ONCE to skip. <<<")
print()

# ---------- hit loop ----------
d131_armed = False
d131_orig = None
hits = 0
quiet_sampled = False
while True:
    hit = wait_pause(link, 25)
    if hit is None:
        print("[%7.2fs] quiet 25s — still watching (Ctrl-C to finish)" % ts())
        continue
    hits += 1
    t = ts()
    nr62 = read_mem(link, 0x7FF0, 1)[0]   # saved by the quiesce prefix
    r = regs_raw()
    sl = slots_list(r)
    anchor_pc = reg16(r, "HL")
    if anchor_pc == 0xD131:
        print("[%7.2fs] HIT %d: FIRST CMD18 AFTER CHAIN  sp=$%04X %s slots=%s"
              % (t, hits, reg16(r, "SP"), engine_state(), sl))
        blk = read_mem(link, 0xF970, 0x90)
        open("%s/hw6_cmd18_h%d_F970.bin" % (SCRATCH, hits), "wb").write(blk)
        set_slot(6, 6)
        wmem(0xD131, d131_orig)
        okr = read_mem(link, 0xD131, 7) == d131_orig
        set_slot(6, sl[6])
        set_slot(3, 11)
        d131_armed = False
        print("  d131 restored ok=%s (track anchor stays armed; re-arms on next chain)" % okr)
        wr_nr(0x62, nr62)
        set_pc(0xD131)
        cont_run(link)
        continue
    # ---- track_start hit ----
    de = reg16(r, "DE")
    track = read_mem(link, 0xF995, 1)[0]
    flags = read_mem(link, 0xF994, 1)[0]
    print("[%7.2fs] HIT %d: track_start trk=$%02X flags=$%02X seed=$%04X  %s slots=%s"
          % (t, hits, track, flags, de, engine_state(), sl))
    set_slot(3, 16)
    b16 = read_mem(link, 0x6000, 0x60)
    set_slot(3, 94)
    print("  bank16[0000..005F]: %s" % b16.hex(" "))
    open("%s/hw9_bank16_h%d.bin" % (SCRATCH, hits), "wb").write(b16)
    deb = bytes([de & 0xFF, de >> 8])
    wmem(0xF992, deb); wmem(0xF990, deb)
    if track == 0x22:
        set_slot(6, 6)
        wmem(0xC949, orig_c949)
        okd = read_mem(link, 0xC949, 7) == orig_c949
        set_slot(6, sl[6])
        set_slot(3, 11)
        wr_nr(0x62, nr62)
        set_pc(0xC951)
        cont_run(link)
        print("[%7.2fs] ANCHOR DISARMED after title-tune start ok=%s — press fire when ready; watching (no further hits possible)" % (ts(), okd))
        continue
    if flags == 0xC0 and not d131_armed:
        set_slot(6, 6)
        d131_orig = read_mem(link, 0xD131, 7)
        wmem(0xD131, ANCHOR_D131)
        okd = read_mem(link, 0xD131, 7) == ANCHOR_D131
        set_slot(6, sl[6])
        d131_armed = True
        print("  refill anchor armed at $D131 ok=%s" % okd)
    set_slot(3, 11)
    wr_nr(0x62, nr62)
    set_pc(0xC951)
    cont_run(link)
