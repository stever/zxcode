#!/usr/bin/env python3
"""Minimal DZRP client for dezogif on a real ZX Spectrum Next.

Talks the DeZog Remote Protocol directly over the joystick-port UART
(921600 8N1) so measurement campaigns can run without VS Code.

Frame format (little-endian):
  command:      [len u32][seq u8][cmd u8][payload]   len = 2 + len(payload)
  response:     [len u32][seq u8][payload]           len = 1 + len(payload)
  notification: [len u32][0x00][ntf u8][payload]

Usage:
  dzrp.py [--port /dev/ttyUSB0] init
  dzrp.py regs
  dzrp.py md ADDR LEN            # hex dump memory
  dzrp.py sniff                  # dump any incoming frames (e.g. NTF_PAUSE)

Every frame in either direction is hex-logged to dzrp.log for
protocol debugging.
"""

import os
import select
import struct
import sys
import termios
import time

CMD_INIT = 1
CMD_CLOSE = 2
CMD_GET_REGISTERS = 3
CMD_SET_REGISTER = 4
CMD_WRITE_BANK = 5
CMD_CONTINUE = 6
CMD_PAUSE = 7
CMD_READ_MEM = 8
CMD_WRITE_MEM = 9
CMD_SET_BREAKPOINTS = 13
CMD_RESTORE_MEM = 14
CMD_ADD_BREAKPOINT = 40
CMD_REMOVE_BREAKPOINT = 41

LOG_PATH = os.path.join(os.getcwd(), "dzrp.log")


def log(direction, data):
    with open(LOG_PATH, "a") as f:
        f.write("%s %s %s\n" % (time.strftime("%H:%M:%S"), direction, data.hex()))


class Link:
    def __init__(self, port="/dev/ttyUSB0"):
        self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        attrs = termios.tcgetattr(self.fd)
        # raw 8N1 at 921600
        attrs[0] = 0                      # iflag
        attrs[1] = 0                      # oflag
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL  # cflag
        attrs[3] = 0                      # lflag
        attrs[4] = termios.B921600        # ispeed
        attrs[5] = termios.B921600        # ospeed
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
        termios.tcflush(self.fd, termios.TCIOFLUSH)
        self.seq = 0
        self.buf = b""

    def next_seq(self):
        self.seq = self.seq % 255 + 1
        return self.seq

    def send(self, cmd, payload=b""):
        # DeZog convention: the length field counts the PAYLOAD only
        # (seq and cmd bytes are excluded) — dzrpbufferremote.ts.
        seq = self.next_seq()
        frame = struct.pack("<IBB", len(payload), seq, cmd) + payload
        log("->", frame)
        # The fd is non-blocking: large frames (8K bank writes) fill
        # the tty buffer, and dezogif's per-byte 100ms timeout aborts
        # the message if we stall — write the remainder as the buffer
        # drains.
        view = memoryview(frame)
        while view:
            try:
                n = os.write(self.fd, view)
            except BlockingIOError:
                n = 0
            if n:
                view = view[n:]
            else:
                select.select([], [self.fd], [], 0.05)
        return seq

    def _read_available(self, timeout):
        r, _, _ = select.select([self.fd], [], [], timeout)
        if not r:
            return False
        try:
            chunk = os.read(self.fd, 65536)
        except BlockingIOError:
            return False
        if chunk:
            self.buf += chunk
            return True
        return False

    def recv_frame(self, timeout=5.0):
        """Return (seq, payload) or None on timeout.

        dezogif prefixes every message it SENDS with a 0xA5 leader
        (the joy port idles with zero bytes); frames we send need no
        leader. Sync on the 0xA5, then [len u32][seq][payload].
        """
        deadline = time.time() + timeout
        while True:
            # sync: drop everything before the next 0xA5 leader
            start = self.buf.find(b"\xa5")
            if start > 0:
                log("!skip", self.buf[:start])
                self.buf = self.buf[start:]
            elif start < 0 and self.buf:
                log("!skip", self.buf)
                self.buf = b""
            if len(self.buf) >= 5:
                length = struct.unpack("<I", self.buf[1:5])[0]
                if 0 < length <= 1 << 20 and len(self.buf) >= 5 + length:
                    frame = self.buf[: 5 + length]
                    self.buf = self.buf[5 + length:]
                    log("<-", frame)
                    return frame[5], frame[6: 5 + length]
                if length == 0 or length > 1 << 20:
                    # false leader — drop it and resync
                    log("!resync", self.buf[:1])
                    self.buf = self.buf[1:]
                    continue
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            self._read_available(min(remaining, 0.2))

    def request(self, cmd, payload=b"", timeout=5.0):
        seq = self.send(cmd, payload)
        while True:
            got = self.recv_frame(timeout)
            if got is None:
                raise TimeoutError("no response to cmd %d" % cmd)
            rseq, rpayload = got
            if rseq == 0:
                print("NOTIFICATION during request:", describe_notification(rpayload))
                continue
            if rseq != seq:
                print("sequence mismatch: sent %d got %d" % (seq, rseq))
            return rpayload


def describe_notification(payload):
    if not payload:
        return "empty"
    if payload[0] == 1 and len(payload) >= 5:
        reason = payload[1]
        addr = struct.unpack("<H", payload[2:4])[0]
        bank = payload[4]
        text = payload[5:].split(b"\x00")[0].decode("ascii", "replace")
        reasons = {0: "step", 1: "manual", 2: "breakpoint", 3: "watch-read",
                   4: "watch-write", 255: "other"}
        return "PAUSE reason=%s addr=$%04X bank+1=%d %s" % (
            reasons.get(reason, reason), addr, bank, text)
    return "ntf id=%d payload=%s" % (payload[0], payload[1:].hex())


REG_NAMES = ["PC", "SP", "AF", "BC", "DE", "HL", "IX", "IY",
             "AF'", "BC'", "DE'", "HL'"]


def parse_registers(p):
    # dezogif sends 14 register pairs (backup struct, PC first), then
    # a slot count byte and 8 slot->bank bytes.
    out = []
    off = 0
    for name in REG_NAMES:
        if off + 2 > len(p):
            break
        out.append("%s=$%04X" % (name, struct.unpack("<H", p[off:off + 2])[0]))
        off += 2
    if off + 4 <= len(p):
        out.append("R=$%02X I=$%02X" % (p[off], p[off + 1]))
        off += 4  # pair 13 = (R,I), pair 14 = internal bytes
    if off < len(p):
        nslots = p[off]
        slots = p[off + 1: off + 1 + nslots]
        out.append("slots=" + ",".join(str(b) for b in slots))
    return " ".join(out)


def perm16k(i):
    # .nex bank storage order: 5, 2, 0, 1, 3, 4, 6, 7, 8, ...
    if i >= 6:
        return i
    return [5, 2, 0, 1, 3, 4][i]


def parse_nex(path):
    """Return (sp, pc, border, entry_bank16, [(bank16, bytes)])."""
    data = open(path, "rb").read()
    if data[:4] != b"Next":
        raise ValueError("not a .nex file")
    screens = data[10]
    border = data[11]
    sp = struct.unpack("<H", data[12:14])[0]
    pc = struct.unpack("<H", data[14:16])[0]
    entry_bank = data[139]
    off = 512
    if screens & 0x7F and not screens & 0x80:
        if screens & 0x05:
            off += 512  # palette
    for flag, size in ((0x01, 49152), (0x02, 6912), (0x04, 12288),
                       (0x08, 12288), (0x10, 12288), (0x40, 81920)):
        if screens & flag:
            off += size
    if data[153] & 0x01:
        off += 2048  # copper block
    banks = []
    for i in range(112):
        k = perm16k(i)
        if data[18 + k]:
            banks.append((k, data[off: off + 16384]))
            off += 16384
    return sp, pc, border, entry_bank, banks


def load_nex(link, path):
    sp, pc, border, entry_bank, banks = parse_nex(path)
    print("nex: SP=$%04X PC=$%04X border=%d entry16k=%d banks16k=%s"
          % (sp, pc, border, entry_bank, [b for b, _ in banks]))
    link.request(12, bytes([border]))  # CMD_SET_BORDER
    for bank16, data in banks:
        for half in (0, 1):
            bank8 = 2 * bank16 + half
            chunk = data[half * 8192: (half + 1) * 8192]
            resp = link.request(CMD_WRITE_BANK, bytes([bank8]) + chunk,
                                timeout=15.0)
            if resp and resp[0] != 0:
                raise RuntimeError("write_bank %d error: %s" % (bank8, resp.hex()))
    entry8 = 2 * entry_bank
    for slot, bank8 in enumerate([255, 255, 10, 11, 4, 5, entry8, entry8 + 1]):
        link.request(10, bytes([slot, bank8]))  # CMD_SET_SLOT
    link.request(CMD_SET_REGISTER, struct.pack("<BH", 1, sp))  # SP
    link.request(CMD_SET_REGISTER, struct.pack("<BH", 0, pc))  # PC
    print("nex loaded, PC/SP set")


def set_bps(link, addrs):
    """Patch breakpoints; returns [(addr, orig_byte)] for restore."""
    payload = b"".join(struct.pack("<HB", a, 0) for a in addrs)
    resp = link.request(CMD_SET_BREAKPOINTS, payload)
    return list(zip(addrs, resp))


def restore_bps(link, entries):
    payload = b"".join(struct.pack("<HBB", a, 0, v) for a, v in entries)
    link.request(CMD_RESTORE_MEM, payload)


def cont_run(link):
    # PAYLOAD_CONTINUE: bp1_enable(1) bp1_addr(2) bp2_enable(1)
    # bp2_addr(2) alternate_command(1) range_start(2) range_end(2)
    link.request(CMD_CONTINUE, bytes(11))


def wait_pause(link, timeout):
    """Block until NTF_PAUSE; return (reason, addr, bankplus1)."""
    deadline = time.time() + timeout
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            return None
        got = link.recv_frame(min(remaining, 30.0))
        if got is None:
            continue
        seq, payload = got
        if seq == 0 and payload and payload[0] == 1:
            print(describe_notification(payload))
            return payload[1], struct.unpack("<H", payload[2:4])[0], payload[4]
        print("unexpected frame seq=%d %s" % (seq, payload.hex()))


def read_mem(link, addr, size):
    return link.request(CMD_READ_MEM, struct.pack("<BHH", 0, addr, size))


def dump_state(link, label):
    print("=== %s ===" % label)
    print(parse_registers(link.request(CMD_GET_REGISTERS)))
    mem = read_mem(link, 0x4CE8, 32)
    print("4CE8:", mem.hex(" "))
    for reg in (0x1E, 0x1F):
        v = link.request(11, bytes([reg]))  # CMD_GET_TBBLUE_REG
        print("NR$%02X = $%02X" % (reg, v[-1]))


def main():
    args = sys.argv[1:]
    port = "/dev/ttyUSB0"
    if args and args[0] == "--port":
        port = args[1]
        args = args[2:]
    if not args:
        print(__doc__)
        return 1
    link = Link(port)
    cmd = args[0]

    if cmd == "init":
        payload = bytes([2, 0, 0]) + b"zxplay_go-probe\x00"
        resp = link.request(CMD_INIT, payload)
        print("INIT response:", resp.hex())
        if len(resp) >= 5:
            print("  error=%d dzrp=%d.%d.%d machine=%d name=%s" % (
                resp[0], resp[1], resp[2], resp[3], resp[4],
                resp[5:].split(b"\x00")[0].decode("ascii", "replace")))
        return 0

    if cmd == "regs":
        resp = link.request(CMD_GET_REGISTERS)
        print("raw:", resp.hex())
        print(parse_registers(resp))
        return 0

    if cmd == "md":
        addr = int(args[1], 16)
        size = int(args[2])
        payload = struct.pack("<BHH", 0, addr, size)
        resp = link.request(CMD_READ_MEM, payload)
        data = resp  # some versions prefix nothing; check log if off-by-one
        for i in range(0, len(data), 16):
            row = data[i:i + 16]
            print("%04X  %s" % (addr + i, " ".join("%02X" % b for b in row)))
        return 0

    if cmd == "loadnex":
        payload = bytes([2, 0, 0]) + b"zxplay_go-probe\x00"
        link.request(CMD_INIT, payload)
        load_nex(link, args[1])
        return 0

    if cmd == "campaign":
        # Full run: init, load, prove bp machinery at $B173 (frame
        # sync, hit within seconds), then re-arm onto $AE0B (the
        # post-slide return that never executes in the emulator).
        nexpath = args[1] if len(args) > 1 else "main.nex"
        link.request(CMD_INIT, bytes([2, 0, 0]) + b"zxplay_go-probe\x00")
        load_nex(link, nexpath)

        bps = set_bps(link, [0xB173])
        print("bp $B173 set, orig byte %02X; starting program" % bps[0][1])
        cont_run(link)
        hit = wait_pause(link, 120)
        if hit is None:
            print("NO PAUSE at $B173 within 120s — bp machinery did not fire")
            return 1
        dump_state(link, "first $B173 hit (pre-install, machinery proven)")
        restore_bps(link, bps)

        bps = set_bps(link, [0xAE0B])
        print("bp $AE0B armed (orig %02X); continuing hands-off" % bps[0][1])
        cont_run(link)
        hit = wait_pause(link, 600)
        if hit is None:
            print("NO PAUSE at $AE0B within 600s.")
            print("If the music is playing: the slide's recovery does not")
            print("return inline on hardware either (or the game rewrote")
            print("the patched byte). Machine still runs — leave it.")
            return 0
        dump_state(link, "$AE0B HIT — slide returned inline on hardware")
        restore_bps(link, bps)
        print("machine left PAUSED at $AE0B. Use regs/md for more, then")
        print("'cont' to resume.")
        return 0

    if cmd == "cont":
        cont_run(link)
        print("continued")
        return 0

    if cmd == "campaign-resume":
        # Banks already loaded, PC/SP set, bp $B173 already patched
        # (orig byte CD) — just start and run the two-stage plan.
        cont_run(link)
        print("program started")
        hit = wait_pause(link, 120)
        if hit is None:
            print("NO PAUSE at $B173 within 120s")
            return 1
        dump_state(link, "first $B173 hit (pre-install, machinery proven)")
        restore_bps(link, [(0xB173, 0xCD)])
        bps = set_bps(link, [0xAE0B])
        print("bp $AE0B armed (orig %02X); continuing hands-off" % bps[0][1])
        cont_run(link)
        hit = wait_pause(link, 600)
        if hit is None:
            print("NO PAUSE at $AE0B within 600s. If music is playing, the")
            print("slide recovery does not return inline on hardware either.")
            return 0
        dump_state(link, "$AE0B HIT — slide returned inline on hardware")
        restore_bps(link, bps)
        print("machine left PAUSED. 'cont' to resume.")
        return 0

    if cmd == "sizetest":
        # Escalating CMD_WRITE_MEM sizes to find where big frames die.
        link.request(CMD_INIT, bytes([2, 0, 0]) + b"zxplay_go-probe\x00")
        for size in (16, 128, 512, 1024, 2048, 4096, 8192):
            payload = struct.pack("<BH", 0, 0x6000) + bytes(range(256)) * (size // 256 + 1)
            payload = payload[: 3 + size]
            t0 = time.time()
            try:
                link.request(CMD_WRITE_MEM, payload, timeout=10.0)
                back = read_mem(link, 0x6000, min(size, 32))
                ok = back == (bytes(range(256)) * 2)[: min(size, 32)]
                print("size %5d: OK (%.2fs) readback %s" % (size, time.time() - t0, "match" if ok else "MISMATCH"))
            except TimeoutError:
                print("size %5d: TIMEOUT" % size)
                return 1
        return 0

    if cmd == "sniff":
        print("listening for frames (ctrl-c to stop)...")
        while True:
            got = link.recv_frame(timeout=3600)
            if got is None:
                continue
            seq, payload = got
            if seq == 0:
                print(describe_notification(payload))
            else:
                print("frame seq=%d payload=%s" % (seq, payload.hex()))

    print("unknown command:", cmd)
    return 1


if __name__ == "__main__":
    sys.exit(main())
