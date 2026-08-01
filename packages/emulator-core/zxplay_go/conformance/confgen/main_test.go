package main

import (
	"os"
	"strings"
	"testing"
)

func testRenderer() *docRenderer {
	return &docRenderer{
		dir: "packages/emulator-core/zxplay_go",
		pages: map[string]string{
			"packages/emulator-core/zxplay_go/DEBUGGER.md":    "debugger.html",
			"packages/emulator-core/zxplay_go/docs/manual.md": "manual.html",
			"docs/emulator/automation.md":                     "automation.html",
		},
		repo:   "https://github.com/stever/zxcode",
		branch: "main",
	}
}

func render(t *testing.T, md string) string {
	t.Helper()
	return string(testRenderer().mdToHTML(md))
}

// A hard-wrapped list item must render as ONE item: the continuation lines
// belong inside the <li>, not as stray text between items. This is the shape
// every bulleted list in these documents has.
func TestList_WrappedItemStaysInsideLi(t *testing.T) {
	got := render(t, "- first item that is\n  wrapped over two lines\n- second item\n")
	want := "<ul>\n<li>first item that is wrapped over two lines</li>\n<li>second item</li>\n</ul>\n"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

// A nested list belongs inside its parent's <li>, and both close in order.
func TestList_NestedInsideParentItem(t *testing.T) {
	got := render(t, "- outer\n  - inner\n- next\n")
	want := "<ul>\n<li>outer<ul>\n<li>inner</li>\n</ul>\n</li>\n<li>next</li>\n</ul>\n"
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestList_OrderedAndUnorderedAreSeparateLists(t *testing.T) {
	got := render(t, "1. one\n2. two\n")
	if !strings.Contains(got, "<ol>\n<li>one</li>\n<li>two</li>\n</ol>") {
		t.Errorf("ordered list not rendered as <ol>: %s", got)
	}
	if strings.Contains(got, "<ul>") {
		t.Errorf("ordered list leaked a <ul>: %s", got)
	}
}

// Emphasis has to survive a code span in the middle of it — the documents
// write things like **the `.nex` path** constantly.
func TestInline_BoldSpansCodeSpan(t *testing.T) {
	got := render(t, "text **running arbitrary `.nex` games is new**.\n")
	want := "<strong>running arbitrary <code>.nex</code> games is new</strong>"
	if !strings.Contains(got, want) {
		t.Errorf("got %q, want it to contain %q", got, want)
	}
}

// ...and a line break, because the sources are hard-wrapped.
func TestInline_BoldSpansWrappedLines(t *testing.T) {
	got := render(t, "intro **bold text that runs\nacross a line break** and continues.\n")
	if !strings.Contains(got, "<strong>bold text that runs across a line break</strong>") {
		t.Errorf("bold not joined across lines: %s", got)
	}
	if strings.Contains(got, "**") {
		t.Errorf("literal ** left in output: %s", got)
	}
}

// Inside a code span nothing is markdown: no links, no emphasis, and the
// content is HTML-escaped.
func TestInline_CodeSpanContentStaysLiteral(t *testing.T) {
	got := render(t, "run `--watch-writes 'A@$40=0' && x<y` now\n")
	want := "<code>--watch-writes &#39;A@$40=0&#39; &amp;&amp; x&lt;y</code>"
	if !strings.Contains(got, want) {
		t.Errorf("got %q, want it to contain %q", got, want)
	}
}

func TestInline_CodeSpanIsNotEmphasised(t *testing.T) {
	got := render(t, "the `a ** b` literal\n")
	if !strings.Contains(got, "<code>a ** b</code>") {
		t.Errorf("code span was reinterpreted: %s", got)
	}
}

// Link rewriting: a document the site publishes becomes its page (keeping
// the anchor); anything else relative goes to GitHub; images go to raw.
func TestLinks_Rewriting(t *testing.T) {
	cases := []struct{ md, want string }{
		{"see [the debugger](DEBUGGER.md)", `href="debugger.html"`},
		{"see [the manual](docs/manual.md#tapes)", `href="manual.html#tapes"`},
		{"see [keyboards](KEYBOARD_GUIDE.md)",
			`href="https://github.com/stever/zxcode/blob/main/packages/emulator-core/zxplay_go/KEYBOARD_GUIDE.md"`},
		{"see [upstream](https://example.org/x)", `href="https://example.org/x"`},
		{"see [above](#honest-status)", `href="#honest-status"`},
		{"![shot](cybernoid.png)",
			`src="https://raw.githubusercontent.com/stever/zxcode/main/packages/emulator-core/zxplay_go/cybernoid.png"`},
	}
	for _, c := range cases {
		if got := render(t, c.md+"\n"); !strings.Contains(got, c.want) {
			t.Errorf("%q\n got: %s\nwant contains: %s", c.md, got, c.want)
		}
	}
}

// A page rendered from outside the site map (no source dir) leaves relative
// links alone rather than inventing a target.
func TestLinks_NoSourceDirLeavesRelativeAlone(t *testing.T) {
	r := &docRenderer{repo: "https://github.com/stever/zxcode", branch: "main"}
	got := string(r.mdToHTML("see [x](other.md)\n"))
	if !strings.Contains(got, `href="other.md"`) {
		t.Errorf("relative link was rewritten without a source dir: %s", got)
	}
}

// Anchors must match the ones GitHub generates, since the documents link to
// their own headings using GitHub's slugs — underscores included.
func TestHeadings_GitHubCompatibleAnchors(t *testing.T) {
	cases := map[string]string{
		"## Using zxplay_go": `<h2 id="using-zxplay_go">`,
		// Dropped punctuation leaves its space behind, exactly as GitHub
		// does — the emulator README's own TOC links #sound--peripherals.
		"## Sound & peripherals": `<h2 id="sound--peripherals">`,
		"## The Spectrum Next":   `<h2 id="the-spectrum-next">`,
		"### `--headless` runs":  `<h3 id="--headless-runs">`,
	}
	for md, want := range cases {
		if got := render(t, md+"\n"); !strings.Contains(got, want) {
			t.Errorf("%q\n got: %s\nwant contains: %s", md, got, want)
		}
	}
}

// A heading inside a blockquote keeps its anchor: the emulator README links
// to its "Honest status" note that way.
func TestBlockquote_HeadingKeepsAnchor(t *testing.T) {
	got := render(t, "> ### Honest status\n>\n> The classic line is mature.\n")
	if !strings.Contains(got, `<p id="honest-status">`) {
		t.Errorf("blockquote heading lost its anchor: %s", got)
	}
	if !strings.Contains(got, "<blockquote>") || !strings.Contains(got, "</blockquote>") {
		t.Errorf("blockquote not closed: %s", got)
	}
}

// Wide tables scroll inside their own container, and it is closed — an
// unclosed wrapper swallowed the rest of the page.
func TestTable_ScrollWrapperIsClosed(t *testing.T) {
	got := render(t, "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nafter\n")
	if strings.Count(got, `<div class="table-scroll">`) != 1 ||
		strings.Count(got, "</table></div>") != 1 {
		t.Errorf("table wrapper not balanced: %s", got)
	}
	if !strings.Contains(got, "<th>A</th>") || !strings.Contains(got, "<td>1</td>") {
		t.Errorf("header/body rows wrong: %s", got)
	}
	if !strings.Contains(got, "<p>after</p>") {
		t.Errorf("content after the table was swallowed: %s", got)
	}
}

func TestFencedCode_IsVerbatim(t *testing.T) {
	got := render(t, "```bash\nzxplay_go --headless *not emphasis*\n```\n")
	want := "<pre data-lang=\"bash\"><code>zxplay_go --headless *not emphasis*\n</code></pre>"
	if !strings.Contains(got, want) {
		t.Errorf("got %q, want it to contain %q", got, want)
	}
}

// The table of contents is built from the rendered h2 anchors.
func TestTableOfContents(t *testing.T) {
	body := render(t, "## First heading\n\ntext\n\n## Second `code` heading\n\n### Not listed\n")
	toc := tableOfContents(body)
	if len(toc) != 2 {
		t.Fatalf("got %d entries, want 2: %+v", len(toc), toc)
	}
	if toc[0].Anchor != "first-heading" || toc[0].Text != "First heading" {
		t.Errorf("first entry wrong: %+v", toc[0])
	}
	if toc[1].Text != "Second code heading" {
		t.Errorf("markup not stripped from TOC text: %+v", toc[1])
	}
}

func TestChromeLink_PrefersSitePageOverGitHub(t *testing.T) {
	ch := newChrome(&siteMap{
		Sections: []siteSection{{Pages: []sitePage{
			{Page: "index.html", Title: "Home", Source: "docs/index.md", Home: true},
			{Page: "known-gaps.html", Title: "Gaps", Source: "packages/x/known-gaps.md"},
		}}},
	}, stamp{})
	if got := ch.Link("packages/x/known-gaps.md"); got != "known-gaps.html" {
		t.Errorf("published document did not resolve to its page: %s", got)
	}
	want := "https://github.com/stever/zxcode/blob/main/packages/x/other.md"
	if got := ch.Link("packages/x/other.md"); got != want {
		t.Errorf("unpublished document: got %s, want %s", got, want)
	}
}

func TestLoadSiteMap_Validation(t *testing.T) {
	cases := []struct {
		name string
		json string
		ok   bool
	}{
		{"valid", `{"sections":[{"pages":[{"page":"a.html","source":"a.md","home":true}]}]}`, true},
		{"no home", `{"sections":[{"pages":[{"page":"a.html","source":"a.md"}]}]}`, false},
		{"two homes", `{"sections":[{"pages":[
			{"page":"a.html","source":"a.md","home":true},
			{"page":"b.html","source":"b.md","home":true}]}]}`, false},
		{"duplicate page", `{"sections":[{"pages":[
			{"page":"a.html","source":"a.md","home":true},
			{"page":"a.html","source":"b.md"}]}]}`, false},
		{"no source and not generated", `{"sections":[{"pages":[
			{"page":"a.html","source":"a.md","home":true},
			{"page":"b.html"}]}]}`, false},
		{"generated needs no source", `{"sections":[{"pages":[
			{"page":"a.html","source":"a.md","home":true},
			{"page":"b.html","generated":true}]}]}`, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := t.TempDir() + "/site.json"
			if err := writeFile(path, c.json); err != nil {
				t.Fatal(err)
			}
			_, err := loadSiteMap(path)
			if c.ok && err != nil {
				t.Errorf("expected valid, got %v", err)
			}
			if !c.ok && err == nil {
				t.Error("expected an error, got none")
			}
		})
	}
}

func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}
