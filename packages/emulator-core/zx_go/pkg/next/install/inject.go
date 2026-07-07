package install

// In-memory ROM injection for hosts without a filesystem (js/wasm). The browser
// downloads the licensed NextZXOS ROMs and hands them to the core via
// zxRegisterROM -> InjectROM; LoadROM consults this map before touching disk.

var injectedROMs = map[string][]byte{}

// DiskDisabled, when true, makes LoadROM skip the filesystem entirely and treat
// any non-injected ROM as "not installed". Set on hosts with no usable FS
// (js/wasm), where os.Getwd/filepath.Abs error out and would otherwise turn an
// absent optional ROM into a fatal boot error.
var DiskDisabled bool

// InjectROM registers ROM bytes under a basename (e.g. DistroROM, DivMMCROM).
// A later LoadROM(filename) returns these bytes instead of reading the install
// directory. Overwrites any previous injection for the same name.
func InjectROM(filename string, data []byte) {
	cp := make([]byte, len(data))
	copy(cp, data)
	injectedROMs[filename] = cp
}
