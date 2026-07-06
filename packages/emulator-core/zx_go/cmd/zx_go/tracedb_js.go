//go:build js && wasm

package main

// js/wasm stand-in for tracedb.go. The real one pulls in modernc.org/sqlite,
// which has no js/wasm build. The in-memory ring is pure Go and kept verbatim;
// only flushSQLite (the sqlite writer) becomes a no-op. Tracing-to-disk is a
// desktop-only diagnostic and is never armed by the wasm entry point anyway.

type traceDBRow struct {
	insn           uint64
	pc, sp         uint16
	af, bc, de, hl uint16
	ix, iy         uint16
	bank           int
	alt            int
	dmc            int
	frame          int
}

type traceDB struct {
	rows []traceDBRow
	cap  int
	head int
	full bool
}

func newTraceDB(capacity int) *traceDB {
	if capacity <= 0 {
		return nil
	}
	return &traceDB{rows: make([]traceDBRow, capacity), cap: capacity}
}

func (t *traceDB) record(r traceDBRow) {
	if t == nil {
		return
	}
	t.rows[t.head] = r
	t.head = (t.head + 1) % t.cap
	if t.head == 0 {
		t.full = true
	}
}

func (t *traceDB) ordered() []traceDBRow {
	if t == nil {
		return nil
	}
	if !t.full {
		return append([]traceDBRow(nil), t.rows[:t.head]...)
	}
	out := make([]traceDBRow, 0, t.cap)
	out = append(out, t.rows[t.head:]...)
	out = append(out, t.rows[:t.head]...)
	return out
}

func (t *traceDB) flushSQLite(path string) (int, error) { return 0, nil }
