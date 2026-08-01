package main

import (
	"github.com/stever/zxplay_go/pkg/next/install"
	"github.com/stever/zxplay_go/pkg/next/sdcard"
)

// prepDistroCard normalises a pristine official Next distro card image
// (e.g. cspect-next-1gb.img from sn-emulator-*.zip) so it boots the way
// our staged, pre-configured cards always have:
//
//   - /nextzxos/autoexec.1st is deleted — it is the NextZXOS first-boot
//     welcome pager, re-shown on EVERY boot until the user presses D to
//     disable it (which deletes this file on real hardware). Left in
//     place it stalls all our menu-driving macros (compile-run, Browser
//     game launch) and the boot fast-forward's menu detection.
//   - /machines/next/config.ini is seeded (install.DefaultNextConfigINI,
//     the same file the desktop distro download writes) when absent, so
//     the hardware-faithful firmware path boots to the NextZXOS menu
//     instead of the first-run config wizard. Never overwrites an
//     existing config.ini.
//
// Both operations are idempotent; a card that is already configured (like
// the staged tbblue.mmc) passes through untouched. Callers apply this only
// to cards THEY sourced from the distro — never to a user-supplied image.
func prepDistroCard(dev sdcard.Image) (deletedWelcome, seededConfig bool, err error) {
	deletedWelcome, err = sdcard.DeleteFileFromImage(dev, "nextzxos", "autoexec.1st")
	if err != nil {
		return false, false, err
	}
	haveCfg, err := sdcard.FileExistsInImage(dev, "machines/next", "config.ini")
	if err != nil {
		return deletedWelcome, false, err
	}
	if !haveCfg {
		if _, err = sdcard.WriteFileToImage(dev, "machines/next", "config.ini",
			[]byte(install.DefaultNextConfigINI)); err != nil {
			return deletedWelcome, false, err
		}
		seededConfig = true
	}
	return deletedWelcome, seededConfig, nil
}
