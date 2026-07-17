package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/conorarmstrong/zx_go/pkg/next/install"
	"github.com/conorarmstrong/zx_go/pkg/next/sdcard"
)

// buildPristineDistroCard synthesises the on-card shape of an official
// sn-emulator distro image: a welcome autoexec.1st present, no
// machines/next/config.ini.
func buildPristineDistroCard(t *testing.T) sdcard.Image {
	t.Helper()
	dir := t.TempDir()
	for _, d := range []string{"nextzxos", "machines/next"} {
		if err := os.MkdirAll(filepath.Join(dir, filepath.FromSlash(d)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string][]byte{
		"nextzxos/autoexec.1st":  bytes.Repeat([]byte{0x33}, 10510),
		"nextzxos/booter.bas":    []byte("welcome booter"),
		"machines/next/menu.def": []byte("menu def content"),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	img, err := sdcard.BuildFAT32(dir, sdcard.FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatalf("BuildFAT32: %v", err)
	}
	src, err := sdcard.NewImageSource(img, false)
	if err != nil {
		t.Fatalf("NewImageSource: %v", err)
	}
	return src
}

func TestPrepDistroCard_NormalisesPristineCard(t *testing.T) {
	dev := buildPristineDistroCard(t)

	deletedWelcome, seededConfig, err := prepDistroCard(dev)
	if err != nil {
		t.Fatalf("prepDistroCard: %v", err)
	}
	if !deletedWelcome {
		t.Error("welcome autoexec.1st not deleted")
	}
	if !seededConfig {
		t.Error("config.ini not seeded")
	}
	if ok, _ := sdcard.FileExistsInImage(dev, "nextzxos", "autoexec.1st"); ok {
		t.Error("autoexec.1st still on the card")
	}
	if ok, _ := sdcard.FileExistsInImage(dev, "machines/next", "config.ini"); !ok {
		t.Error("config.ini missing after prep")
	}
	// Unrelated files survive.
	if ok, _ := sdcard.FileExistsInImage(dev, "nextzxos", "booter.bas"); !ok {
		t.Error("booter.bas lost during prep")
	}
}

func TestPrepDistroCard_ConfiguredCardPassesThrough(t *testing.T) {
	dev := buildPristineDistroCard(t)
	if _, _, err := prepDistroCard(dev); err != nil {
		t.Fatalf("first prep: %v", err)
	}
	// Second prep: nothing to do, nothing overwritten.
	deletedWelcome, seededConfig, err := prepDistroCard(dev)
	if err != nil {
		t.Fatalf("second prep: %v", err)
	}
	if deletedWelcome || seededConfig {
		t.Errorf("second prep not a no-op: deletedWelcome=%v seededConfig=%v",
			deletedWelcome, seededConfig)
	}
}

func TestPrepDistroCard_NeverOverwritesUserConfig(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "machines", "next"), 0o755); err != nil {
		t.Fatal(err)
	}
	custom := []byte("; user's own config\nscandoubler=0\n")
	if err := os.WriteFile(filepath.Join(dir, "machines", "next", "config.ini"), custom, 0o644); err != nil {
		t.Fatal(err)
	}
	img, err := sdcard.BuildFAT32(dir, sdcard.FAT32Opts{SizeMB: 64})
	if err != nil {
		t.Fatalf("BuildFAT32: %v", err)
	}
	src, err := sdcard.NewImageSource(img, false)
	if err != nil {
		t.Fatalf("NewImageSource: %v", err)
	}

	_, seededConfig, err := prepDistroCard(src)
	if err != nil {
		t.Fatalf("prepDistroCard: %v", err)
	}
	if seededConfig {
		t.Error("prep claimed to seed config.ini over an existing one")
	}
	if len(install.DefaultNextConfigINI) == 0 {
		t.Fatal("DefaultNextConfigINI empty?")
	}
}

// TestPrepDistroCard_OfficialImage runs the prep against a REAL pristine
// distro image (licensed content, so never committed): point
// ZX_GO_DISTRO_IMG at e.g. cspect-next-1gb.img from the official
// sn-emulator zip. With ZX_GO_DISTRO_IMG_OUT also set, the prepped card
// is written there — feed that to the boot regression tests from the
// README's "Next boot modes" section to verify a distro update end to end.
func TestPrepDistroCard_OfficialImage(t *testing.T) {
	path := os.Getenv("ZX_GO_DISTRO_IMG")
	if path == "" {
		t.Skip("set ZX_GO_DISTRO_IMG to a pristine official distro image")
	}
	img, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	src, err := sdcard.NewImageSource(img, false)
	if err != nil {
		t.Fatalf("NewImageSource: %v", err)
	}
	deletedWelcome, seededConfig, err := prepDistroCard(src)
	if err != nil {
		t.Fatalf("prepDistroCard: %v", err)
	}
	if !deletedWelcome || !seededConfig {
		t.Errorf("pristine official image: deletedWelcome=%v seededConfig=%v, want both true",
			deletedWelcome, seededConfig)
	}
	if out := os.Getenv("ZX_GO_DISTRO_IMG_OUT"); out != "" {
		if err := src.WriteBackTo(out); err != nil {
			t.Fatalf("write prepped image to %s: %v", out, err)
		}
		t.Logf("prepped image written to %s", out)
	}
}
