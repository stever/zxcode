//go:build js && wasm

package main

// Browser debug bridge.
//
// The desktop debugger has two halves: the command layer (handleCommand and
// the *_cmd.go implementations) and the headless loop that cooperates with
// it — WaitIfPaused owns the pause-ack handshake and executes single steps.
// On wasm the CPU runs on the JS main thread (zxFrame), so there is no
// headless loop. A stand-in goroutine parked in WaitIfPaused supplies the
// cooperation the command layer expects; it is safe because a zxDebug* call
// and zxFrame can never overlap on the single JS thread — the ack is
// bookkeeping, never a real fence.
//
// Two commands cannot be reused as-is:
//   - step-over blocks in waitForPauseAck until the one-shot fires, but on
//     wasm the CPU only advances when JS calls zxFrame — which cannot happen
//     while the JS thread is blocked inside zxDebugCmd. wasmStepOver plants
//     the one-shot and returns; the frame loop delivers the pause through
//     zxFrame's return value.
//   - there is no step-frame command; zxDebugStepFrame runs exactly one
//     frame's worth of T-states synchronously while staying paused.

import (
	"fmt"
	"strings"
	"syscall/js"
	"time"

	"github.com/conorarmstrong/zx_go/pkg/debugger"
	"github.com/conorarmstrong/zx_go/pkg/next/divmmc"
	"github.com/conorarmstrong/zx_go/pkg/roms"
)

var (
	wasmDbg     *remoteDebugger
	wasmDbgEmu  *emulator
	wasmDbgStop chan struct{}
)

func wasmDebugAttached(e *emulator) bool {
	return wasmDbg != nil && e != nil && wasmDbgEmu == e
}

// wasmDebugPaused reports whether the debugger holds THIS emulator paused.
// Consulted by zxFrame to skip execution and to report pause transitions.
func wasmDebugPaused(e *emulator) bool {
	return wasmDebugAttached(e) && wasmDbg.paused.Load()
}

func wasmDebugAttach() bool {
	e := wasmEmu
	if e == nil {
		return false
	}
	if wasmDebugAttached(e) {
		return true
	}
	wasmDebugDetach()
	d := newDebuggerCore(e, false, 0, false)
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			d.WaitIfPaused()
			time.Sleep(5 * time.Millisecond)
		}
	}()
	wasmDbg = d
	wasmDbgEmu = e
	wasmDbgStop = stop
	return true
}

func wasmDebugDetach() {
	if wasmDbg == nil {
		return
	}
	d := wasmDbg
	e := wasmDbgEmu
	wasmDbg = nil
	wasmDbgEmu = nil
	close(wasmDbgStop)
	// Unpark the stand-in goroutine if it is inside WaitIfPaused, and leave
	// the machine free-running.
	d.paused.Store(false)
	d.stepping.Store(false)
	select {
	case d.resumeCh <- struct{}{}:
	default:
	}
	if e != nil && e.cpu != nil {
		e.cpu.BreakpointCheck = nil
	}
}

// wasmStepOver mirrors cmdStepOver without its blocking wait (see the file
// comment). Non-call instructions degrade to a plain step, which completes
// synchronously via the stand-in goroutine.
func wasmStepOver(d *remoteDebugger) string {
	c := d.emu.cpu
	mem := d.emu.mem
	read := func(a uint16) byte { return mem.Read(a) }
	lines := debugger.Disassemble(read, c.PC, 1)
	if len(lines) == 0 || len(lines[0].Bytes) == 0 ||
		!isCallLike(lines[0].Bytes[0], lines[0].Bytes) {
		return d.handleCommand("step")
	}
	target := c.PC + uint16(len(lines[0].Bytes))
	d.stepOverPC.Store(&target)
	d.paused.Store(false)
	d.stepping.Store(false)
	select {
	case d.resumeCh <- struct{}{}:
	default:
	}
	return fmt.Sprintf("OK step-over running to $%04X", target)
}

func wasmDebugStateMap(d *remoteDebugger) map[string]any {
	c := d.emu.cpu
	return map[string]any{
		"pc":     int(c.PC),
		"sp":     int(c.SP),
		"af":     int(c.A)<<8 | int(c.F),
		"bc":     int(c.B)<<8 | int(c.C),
		"de":     int(c.D)<<8 | int(c.E),
		"hl":     int(c.H)<<8 | int(c.L),
		"ix":     int(c.IX),
		"iy":     int(c.IY),
		"afAlt":  int(c.A_)<<8 | int(c.F_),
		"bcAlt":  int(c.B_)<<8 | int(c.C_),
		"deAlt":  int(c.D_)<<8 | int(c.E_),
		"hlAlt":  int(c.H_)<<8 | int(c.L_),
		"i":      int(c.I),
		"r":      int(c.R),
		"im":     int(c.IM),
		"iff1":   c.IFF1,
		"halted": c.Halted,
		"paused": d.paused.Load(),
	}
}

func setupWasmDebugExports(g js.Value) {
	// zxDebugAttach() -> bool. Binds a debugger to the current machine
	// (reusing an existing binding). Re-attach after machine switches.
	g.Set("zxDebugAttach", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		return wasmDebugAttach()
	}))

	g.Set("zxDebugDetach", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		wasmDebugDetach()
		return nil
	}))

	// zxDebugCmd(line) -> "OK ..." / "ERR ...". The same dispatch the
	// desktop telnet debugger uses, so the whole command set (and anything
	// added upstream) works here; step-over reroutes to the non-blocking
	// wasm variant.
	g.Set("zxDebugCmd", js.FuncOf(func(_ js.Value, a []js.Value) any {
		d := wasmDbg
		if d == nil || len(a) < 1 {
			return "ERR no debug session"
		}
		line := strings.TrimSpace(a[0].String())
		fields := strings.Fields(line)
		if len(fields) > 0 {
			switch strings.ToLower(fields[0]) {
			case "step-over", "n", "next":
				return wasmStepOver(d)
			}
		}
		return d.handleCommand(line)
	}))

	// zxDebugState() -> register/pause snapshot. Always safe on wasm: the
	// CPU cannot be mid-instruction while JS runs.
	g.Set("zxDebugState", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		d := wasmDbg
		if d == nil {
			return js.Null()
		}
		return js.ValueOf(wasmDebugStateMap(d))
	}))

	// zxDebugMem(addr, dst Uint8Array) -> n. Reads through Memory.Read so
	// MMU paging / divMMC overlay resolve exactly as the guest sees them.
	g.Set("zxDebugMem", js.FuncOf(func(_ js.Value, a []js.Value) any {
		d := wasmDbg
		if d == nil || len(a) < 2 || a[1].IsUndefined() || a[1].IsNull() {
			return 0
		}
		addr := a[0].Int()
		n := a[1].Get("length").Int()
		buf := make([]byte, n)
		for i := 0; i < n; i++ {
			buf[i] = d.emu.mem.Read(uint16((addr + i) & 0xFFFF))
		}
		js.CopyBytesToJS(a[1], buf)
		return n
	}))

	// zxDebugDisasm(addr, count) -> [{addr, bytes, text}]. Structured feed
	// for the disassembly panel; the text `disassemble` command remains
	// available through zxDebugCmd for console use.
	g.Set("zxDebugDisasm", js.FuncOf(func(_ js.Value, a []js.Value) any {
		d := wasmDbg
		if d == nil || len(a) < 2 {
			return js.ValueOf([]any{})
		}
		addr := uint16(a[0].Int() & 0xFFFF)
		count := a[1].Int()
		if count <= 0 || count > 256 {
			count = 32
		}
		mem := d.emu.mem
		read := func(x uint16) byte { return mem.Read(x) }
		lines := debugger.Disassemble(read, addr, count)
		rows := make([]any, 0, len(lines))
		for _, l := range lines {
			bytes := make([]any, len(l.Bytes))
			for i, b := range l.Bytes {
				bytes[i] = int(b)
			}
			text := l.Mnem
			if l.Operand != "" {
				text += " " + l.Operand
			}
			rows = append(rows, map[string]any{
				"addr":  int(l.Addr),
				"bytes": bytes,
				"text":  text,
			})
		}
		return js.ValueOf(rows)
	}))

	// zxDebugPaging() -> memory-map snapshot for the paging panel, the raw
	// facts the desktop PageMapWidget classifies (pkg/debugger/pagemap.go);
	// the browser panel applies the same rules. Classic models report the
	// four 16K slots (>=16 → ROM n-16); the Next reports the eight 8K MMU
	// slots (0xFF → ROM) plus whether the divMMC overlay covers the bottom
	// 16K.
	g.Set("zxDebugPaging", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		d := wasmDbg
		if d == nil || d.emu == nil || d.emu.mem == nil {
			return js.Null()
		}
		mem := d.emu.mem
		model := mem.GetCurrentModel()
		if model == roms.ModelNext {
			slots := make([]any, 8)
			for i := 0; i < 8; i++ {
				slots[i] = int(mem.GetMMU(byte(i)))
			}
			divmmcPaged := false
			if d.emu.ula != nil {
				if pager, ok := d.emu.ula.NextDivMMC().(*divmmc.Pager); ok && pager != nil {
					divmmcPaged = pager.IsPagedIn()
				}
			}
			return js.ValueOf(map[string]any{
				"mode":        "next",
				"slots":       slots,
				"divmmcPaged": divmmcPaged,
			})
		}
		readMap, _ := mem.GetPageMap()
		slots := make([]any, 4)
		for i := 0; i < 4; i++ {
			slots[i] = readMap[i]
		}
		is128K := model == roms.Model128K || model == roms.ModelPlus2 ||
			model == roms.ModelPlus2A || model == roms.ModelPlus3
		// Raw paging-port state for the panel's footer line: 7FFD
		// (bank/ROM/shadow/lock), 1FFD on the 4-ROM machines, and
		// whether +3 special (all-RAM) paging is active.
		port7FFD, port1FFD, special := mem.GetPortState()
		return js.ValueOf(map[string]any{
			"mode":          "classic",
			"slots":         slots,
			"screenPage":    mem.ScreenPage,
			"is128K":        is128K,
			"plus3":         model == roms.ModelPlus2A || model == roms.ModelPlus3,
			"port7FFD":      int(port7FFD),
			"port1FFD":      int(port1FFD),
			"specialPaging": special,
		})
	}))

	// zxDebugStepFrame() -> "OK ...". Runs exactly one frame's worth of
	// T-states while remaining paused — the CPU stops again at the frame
	// boundary. Peripherals tick so raster/AY state stays coherent.
	g.Set("zxDebugStepFrame", js.FuncOf(func(_ js.Value, _ []js.Value) any {
		d := wasmDbg
		e := wasmDbgEmu
		if d == nil || e == nil {
			return "ERR no debug session"
		}
		if !d.paused.Load() {
			return "ERR not paused"
		}
		d.paused.Store(false)
		e.cpu.ExecuteFrame(frameTStatesForModel(e.model))
		if e.peripherals != nil {
			e.peripherals.Frame()
		}
		d.paused.Store(true)
		return fmt.Sprintf("OK frame stepped, pc=$%04X", e.cpu.PC)
	}))
}
