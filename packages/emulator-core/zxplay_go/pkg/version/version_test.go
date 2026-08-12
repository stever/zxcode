package version

import (
	"regexp"
	"strings"
	"testing"
)

func TestVersionString(t *testing.T) {
	// Shape, not value: an exact pin goes stale on every release bump
	// (the release workflow's verify-version job checks the tag agrees
	// with this constant, so the pin added nothing).
	if !regexp.MustCompile(`^v\d+\.\d+\.\d+$`).MatchString(Version) {
		t.Errorf("Version = %q, want vMAJOR.MINOR.PATCH", Version)
	}
	if !strings.HasPrefix(String(), "zxplay_go ") || !strings.Contains(String(), Version) {
		t.Errorf("String() = %q, want it to embed the product name + version", String())
	}
}
