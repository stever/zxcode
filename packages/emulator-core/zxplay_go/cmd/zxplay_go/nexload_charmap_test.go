package main

import "testing"

// Every character tapToNext can put in a .nex/.bas filename must be typeable by
// the nexload macro. tapToNext sanitises names to [a-z0-9_-]; the macro drops
// any char it can't type, so a name with a dropped char lands on the wrong
// path and NextZXOS reports "No such file or dir". Underscore (from compiler
// temp names like tmp_xxxx) was the gap that caused intermittent failures.
func TestNexKeyMatrixCoversSanitisedFilenameChars(t *testing.T) {
	const sanitised = "abcdefghijklmnopqrstuvwxyz0123456789_-"
	for _, c := range sanitised {
		if _, ok := nexKeyMatrix[c]; !ok {
			t.Errorf("nexKeyMatrix cannot type %q — a filename containing it would be mistyped", string(c))
		}
	}
}

// The path separators/extension the macro also has to type for an /imported/…
// .nex command must be present too.
func TestNexKeyMatrixCoversPathPunctuation(t *testing.T) {
	for _, c := range "/. " {
		if _, ok := nexKeyMatrix[c]; !ok {
			t.Errorf("nexKeyMatrix cannot type path char %q", string(c))
		}
	}
}

// Regression for the specific bug: '_' is SYMBOL SHIFT + 0.
func TestUnderscoreIsSymbolShiftZero(t *testing.T) {
	keys, ok := nexKeyMatrix['_']
	if !ok {
		t.Fatal("'_' missing from nexKeyMatrix")
	}
	want := [][2]int{{7, 0x02}, {4, 0x01}} // SYMBOL SHIFT + 0
	if len(keys) != len(want) {
		t.Fatalf("'_' = %v, want %v", keys, want)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Fatalf("'_' = %v, want %v", keys, want)
		}
	}
}
