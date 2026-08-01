// confgen renders the ZX Play documentation site and the zxplay_go
// conformance dashboard as one static site, published to GitHub Pages by
// .github/workflows/pages.yml. Everything it emits is GENERATED — never
// hand-edit the output; change the inputs instead.
//
// Inputs:
//
//	-site      docs/site.json — the documentation site map (sections ->
//	           pages -> markdown sources). Optional: without it confgen
//	           behaves exactly as it did before the docs site existed and
//	           writes the conformance dashboard as index.html.
//	-root      directory the site map's source paths resolve against
//	           (the repository root).
//	-manifest  conformance manifest (entries + per-suite breakdowns).
//	-results   `go test -json` output, resolving each runner's live status.
//	-gaps      known-gaps.md, rendered as tables on the dashboard.
//	-vhdl      VHDL_CONFORMANCE.md, rendered as vhdl.html.
//
// The documentation pages are markdown files that live where they are
// maintained — the authored site pages under docs/, and the emulator's own
// README / manual / DEBUGGER.md / architecture docs in the emulator tree.
// They are single-sourced: confgen renders them, it does not copy them, and
// relative links between them are rewritten to the corresponding site page
// (or to GitHub when the target is not part of the site).
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"html/template"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type runner struct {
	Package string   `json:"package"`
	Tests   []string `json:"tests"`
}

type entry struct {
	ID      string  `json:"id"`
	Title   string  `json:"title"`
	Area    string  `json:"area"`
	Kind    string  `json:"kind"`
	Oracle  string  `json:"oracle"`
	Status  string  `json:"status"`
	Roadmap string  `json:"roadmap"`
	Link    string  `json:"link"`
	Detail  string  `json:"detail"`
	Notes   string  `json:"notes"`
	Runner  *runner `json:"runner"`
}

type subtest struct {
	Name   string  `json:"name"`
	Path   string  `json:"path"`
	Status string  `json:"status"`
	Notes  string  `json:"notes"`
	Runner *runner `json:"runner"`
}

type group struct {
	Name  string    `json:"name"`
	Tests []subtest `json:"tests"`
}

type suite struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Page        string  `json:"page"`
	Link        string  `json:"link"`
	Description string  `json:"description"`
	Groups      []group `json:"groups"`
}

type manifest struct {
	Entries []entry `json:"entries"`
	Suites  []suite `json:"suites"`
}

// testEvent is the subset of the test2json stream confgen consumes.
type testEvent struct {
	Action  string `json:"Action"`
	Package string `json:"Package"`
	Test    string `json:"Test"`
}

// mdTable is one markdown table with the heading it appeared under.
type mdTable struct {
	Heading string
	Headers []string
	Rows    [][]string
}

// --- the documentation site map ---

// sitePage is one page of the site. Exactly one of Source (a markdown file
// rendered into Page) or Generated (a page some other part of confgen
// writes, listed here only so it appears in the navigation) applies.
type sitePage struct {
	Page      string `json:"page"`      // output file name, e.g. "automation.html"
	Title     string `json:"title"`     // nav label and <title>
	Source    string `json:"source"`    // markdown path, relative to -root
	Summary   string `json:"summary"`   // one line, shown on the home page
	Generated bool   `json:"generated"` // written elsewhere (dashboard, suites, vhdl)
	Home      bool   `json:"home"`      // this page is the site index
}

type siteSection struct {
	Title string     `json:"title"`
	Intro string     `json:"intro"`
	Pages []sitePage `json:"pages"`
}

type siteMap struct {
	Title    string        `json:"title"`
	Tagline  string        `json:"tagline"`
	Repo     string        `json:"repo"`   // e.g. https://github.com/stever/zxcode
	Branch   string        `json:"branch"` // e.g. main
	Sections []siteSection `json:"sections"`
}

func main() {
	manifestPath := flag.String("manifest", "manifest.json", "conformance manifest")
	resultsPath := flag.String("results", "", "go test -json output (optional)")
	gapsPath := flag.String("gaps", "", "known-gaps.md to render (optional)")
	vhdlPath := flag.String("vhdl", "", "VHDL_CONFORMANCE.md to render as vhdl.html (optional)")
	sitePath := flag.String("site", "", "documentation site map (docs/site.json); without it only the conformance dashboard is written")
	rootDir := flag.String("root", ".", "repository root the site map's source paths resolve against")
	outDir := flag.String("out", "site", "output directory")
	flag.Parse()

	m, err := loadManifest(*manifestPath)
	if err != nil {
		log.Fatalf("manifest: %v", err)
	}

	results := map[string]string{}
	if *resultsPath != "" {
		results, err = loadResults(*resultsPath)
		if err != nil {
			log.Fatalf("results: %v", err)
		}
	}

	var gaps []mdTable
	if *gapsPath != "" {
		gaps, err = loadTables(*gapsPath)
		if err != nil {
			log.Fatalf("gaps: %v", err)
		}
	}

	var sm *siteMap
	if *sitePath != "" {
		sm, err = loadSiteMap(*sitePath)
		if err != nil {
			log.Fatalf("site: %v", err)
		}
	}

	resolveEntries(m.Entries, results)
	for i := range m.Suites {
		resolveSuite(&m.Suites[i], results)
	}

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatal(err)
	}
	// .nojekyll stops GitHub Pages from routing the artifact through Jekyll.
	if err := os.WriteFile(filepath.Join(*outDir, ".nojekyll"), nil, 0o644); err != nil {
		log.Fatal(err)
	}

	ch := newChrome(sm, footerStamp())

	// Without a site map the dashboard is the site, and keeps index.html —
	// the layout every existing link to the published page expects.
	if sm == nil {
		ch.Conformance = "index.html"
	}

	if err := renderIndex(*outDir, m, gaps, ch); err != nil {
		log.Fatalf("dashboard: %v", err)
	}
	for _, s := range m.Suites {
		if err := renderSuite(*outDir, s, ch); err != nil {
			log.Fatalf("suite %s: %v", s.ID, err)
		}
	}
	if *vhdlPath != "" {
		if err := renderDoc(*outDir, "vhdl.html", "VHDL conformance matrix", *vhdlPath, ch, nil); err != nil {
			log.Fatalf("vhdl: %v", err)
		}
	}
	if sm != nil {
		if err := renderSite(*outDir, *rootDir, sm, ch); err != nil {
			log.Fatalf("site: %v", err)
		}
	}
	fmt.Printf("wrote %s\n", *outDir)
}

func loadManifest(path string) (*manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func loadSiteMap(path string) (*siteMap, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var sm siteMap
	if err := json.Unmarshal(data, &sm); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	home := 0
	for _, sec := range sm.Sections {
		for _, p := range sec.Pages {
			if p.Page == "" {
				return nil, fmt.Errorf("section %q has a page with no output name", sec.Title)
			}
			if seen[p.Page] {
				return nil, fmt.Errorf("duplicate output page %q", p.Page)
			}
			seen[p.Page] = true
			if p.Source == "" && !p.Generated {
				return nil, fmt.Errorf("page %q has neither a source nor generated:true", p.Page)
			}
			if p.Home {
				home++
			}
		}
	}
	if home != 1 {
		return nil, fmt.Errorf("expected exactly one page with home:true, found %d", home)
	}
	return &sm, nil
}

// loadResults reduces the test2json event stream to a status per
// package/test key. Only terminal actions carry a verdict.
func loadResults(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	statuses := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var ev testEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			continue
		}
		if ev.Test == "" {
			continue
		}
		switch ev.Action {
		case "pass", "fail", "skip":
			statuses[ev.Package+"/"+ev.Test] = ev.Action
		}
	}
	return statuses, sc.Err()
}

var severity = map[string]int{"pass": 0, "skip": 1, "not run": 2, "fail": 3}

func worse(a, b string) string {
	if a == "" {
		return b
	}
	if severity[b] > severity[a] {
		return b
	}
	return a
}

// runnerStatus resolves a runner against the results: any fail wins,
// then "not run" (renamed test — fix the manifest), then skip, then pass.
func runnerStatus(r *runner, results map[string]string) string {
	status := ""
	for _, t := range r.Tests {
		got, ok := results[r.Package+"/"+t]
		if !ok {
			got = "not run"
		}
		status = worse(status, got)
	}
	return status
}

func resolveEntries(entries []entry, results map[string]string) {
	for i := range entries {
		e := &entries[i]
		if e.Runner != nil {
			e.Status = runnerStatus(e.Runner, results)
		} else if e.Status == "" {
			e.Status = "planned"
		}
	}
}

func resolveSuite(s *suite, results map[string]string) {
	for gi := range s.Groups {
		for ti := range s.Groups[gi].Tests {
			t := &s.Groups[gi].Tests[ti]
			if t.Runner != nil {
				t.Status = runnerStatus(t.Runner, results)
			} else if t.Status == "" {
				t.Status = "planned"
			}
		}
	}
}

// loadTables extracts every markdown table from a document along with the
// nearest heading above it.
func loadTables(path string) ([]mdTable, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var tables []mdTable
	heading := ""
	var current *mdTable
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") {
			heading = strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
			current = nil
			continue
		}
		if strings.HasPrefix(trimmed, "|") {
			cells := splitRow(trimmed)
			if isSeparator(cells) {
				continue
			}
			if current == nil {
				tables = append(tables, mdTable{Heading: heading, Headers: cells})
				current = &tables[len(tables)-1]
				continue
			}
			current.Rows = append(current.Rows, cells)
			continue
		}
		current = nil
	}
	return tables, nil
}

func splitRow(line string) []string {
	line = strings.Trim(line, "|")
	parts := strings.Split(line, "|")
	cells := make([]string, len(parts))
	for i, p := range parts {
		cells[i] = strings.TrimSpace(p)
	}
	return cells
}

func isSeparator(cells []string) bool {
	for _, c := range cells {
		if strings.Trim(c, ":- ") != "" {
			return false
		}
	}
	return true
}

// --- markdown → HTML ---

var (
	imageRe  = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]+)(?:\s+&#34;[^)]*&#34;)?\)`)
	linkRe   = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)(?:\s+&#34;[^)]*&#34;)?\)`)
	boldRe   = regexp.MustCompile(`\*\*(.+?)\*\*`)
	italicRe = regexp.MustCompile(`(^|[\s(])\*([^*\s][^*]*)\*($|[\s).,;:!?])`)
	// Ordered list items: "1. text", "12) text".
	orderedRe  = regexp.MustCompile(`^(\d{1,3})[.)]\s+(.*)$`)
	slugDropRe = regexp.MustCompile(`[^a-z0-9 _-]+`)
)

// docRenderer renders one markdown document. It carries the link context
// needed to rewrite relative links: which repo-relative file this document
// is, which repo files the site publishes as pages, and where to send links
// that leave the site.
type docRenderer struct {
	dir    string            // directory of the source, repo-relative ("" for none)
	pages  map[string]string // repo-relative source path -> output page
	repo   string            // https://github.com/owner/repo
	branch string
}

func (r *docRenderer) blobURL(p string) string {
	if r.repo == "" {
		return ""
	}
	branch := r.branch
	if branch == "" {
		branch = "main"
	}
	return r.repo + "/blob/" + branch + "/" + p
}

func (r *docRenderer) rawURL(p string) string {
	if r.repo == "" {
		return ""
	}
	branch := r.branch
	if branch == "" {
		branch = "main"
	}
	return strings.Replace(r.repo, "https://github.com/", "https://raw.githubusercontent.com/", 1) +
		"/" + branch + "/" + p
}

// resolveHref maps a markdown link target to its address on the published
// site. Absolute URLs and pure anchors pass through. A relative path that
// names a document the site publishes becomes that page (keeping any
// anchor); anything else relative becomes a link into the repository on
// GitHub, so no link silently dead-ends.
func (r *docRenderer) resolveHref(href string, image bool) string {
	switch {
	case href == "",
		strings.HasPrefix(href, "#"),
		strings.HasPrefix(href, "http://"),
		strings.HasPrefix(href, "https://"),
		strings.HasPrefix(href, "mailto:"),
		strings.HasPrefix(href, "/"):
		return href
	}
	target, anchor := href, ""
	if i := strings.IndexByte(href, '#'); i >= 0 {
		target, anchor = href[:i], href[i:]
	}
	if r.dir == "" {
		return href
	}
	clean := path.Clean(path.Join(r.dir, target))
	if image {
		if u := r.rawURL(clean); u != "" {
			return u
		}
		return href
	}
	if page, ok := r.pages[clean]; ok {
		return page + anchor
	}
	if u := r.blobURL(clean); u != "" {
		return u + anchor
	}
	return href
}

// codeMarkOpen / codeMarkClose delimit a lifted code span while the rest
// of the line is processed. Private-use code points: not produced by any
// source document, and passed through unchanged by the HTML escaper.
const (
	codeMarkOpen  = "\ue000"
	codeMarkClose = "\ue001"
)

// inline renders the inline markdown forms. Code spans are lifted out to
// placeholders first, so their contents stay literal (no emphasis, no link
// syntax) while everything AROUND them is still processed as one string —
// which is what lets emphasis span a code span, as in **the `.nex` path**.
func (r *docRenderer) inline(s string) template.HTML {
	var code []string
	var lifted strings.Builder
	// The sentinel must survive HTML escaping intact: NUL does not (the
	// escaper rewrites it to U+FFFD), so a private-use pair is used, and
	// any occurrence in the source is dropped first so it cannot collide.
	s = strings.NewReplacer(codeMarkOpen, "", codeMarkClose, "").Replace(s)
	for len(s) > 0 {
		i := strings.IndexByte(s, '`')
		if i < 0 {
			lifted.WriteString(s)
			break
		}
		lifted.WriteString(s[:i])
		rest := s[i+1:]
		j := strings.IndexByte(rest, '`')
		if j < 0 {
			// Unmatched backtick — the remainder is literal text.
			lifted.WriteString(s[i:])
			break
		}
		fmt.Fprintf(&lifted, "%s%d%s", codeMarkOpen, len(code), codeMarkClose)
		code = append(code, rest[:j])
		s = rest[j+1:]
	}

	out := r.inlineText(lifted.String())
	for i, c := range code {
		out = strings.Replace(out, fmt.Sprintf("%s%d%s", codeMarkOpen, i, codeMarkClose),
			"<code>"+template.HTMLEscapeString(c)+"</code>", 1)
	}
	return template.HTML(out)
}

func (r *docRenderer) inlineText(s string) string {
	s = template.HTMLEscapeString(s)
	s = imageRe.ReplaceAllStringFunc(s, func(m string) string {
		g := imageRe.FindStringSubmatch(m)
		return fmt.Sprintf(`<img src="%s" alt="%s">`, r.resolveHref(g[2], true), g[1])
	})
	s = linkRe.ReplaceAllStringFunc(s, func(m string) string {
		g := linkRe.FindStringSubmatch(m)
		return fmt.Sprintf(`<a href="%s">%s</a>`, r.resolveHref(g[2], false), g[1])
	})
	s = boldRe.ReplaceAllString(s, `<strong>$1</strong>`)
	// Underscore emphasis is deliberately not supported: identifiers in
	// these documents (zxplay_go, AUTH_DEV_MODE, …) are full of underscores.
	s = italicRe.ReplaceAllString(s, `$1<em>$2</em>$3`)
	return s
}

// slug builds a GitHub-compatible heading anchor so that intra-document
// links written for GitHub (#the-spectrum-next) resolve on the site too.
func slug(s string) string {
	s = strings.ToLower(s)
	s = strings.NewReplacer("`", "", "*", "", "[", "", "]", "").Replace(s)
	// Drop a link's target, keeping its text: "[a](b)" already lost its
	// brackets above, so remove any trailing "(...)" parenthetical URL.
	s = slugDropRe.ReplaceAllString(s, "")
	s = strings.TrimSpace(s)
	return strings.ReplaceAll(s, " ", "-")
}

// listState tracks one level of an open list while rendering. itemOpen says
// whether that level currently has an unclosed <li> — a list item stays open
// across its wrapped continuation lines and around any list nested inside it,
// so both end up inside the item rather than as stray text between items.
type listState struct {
	indent   int
	ordered  bool
	itemOpen bool
}

// mdToHTML converts the markdown subset these documents use: ATX headings
// (with GitHub-compatible anchors), fenced code blocks, pipe tables,
// bulleted and numbered lists with nesting, blockquotes, horizontal rules,
// paragraphs, and the inline forms above. Anything fancier passes through
// as escaped text.
//
// Inline markup is rendered per BLOCK, not per line: a paragraph, list item
// or quote accumulates its wrapped source lines and they are joined before
// inline() sees them. These documents are hard-wrapped, so emphasis and
// links routinely straddle a line break, and rendering line-at-a-time would
// leave the markers as literal text.
func (r *docRenderer) mdToHTML(src string) template.HTML {
	var b strings.Builder
	lines := strings.Split(src, "\n")
	var lists []listState
	inTable, inQuote := false, false

	// Pending inline blocks, held until something ends them.
	var para, item, quote []string

	// flushItem emits the pending list item's text. The <li> is written
	// here (not when the item started) so that everything belonging to the
	// item — its wrapped lines — is already in hand.
	flushItem := func() {
		if item == nil {
			return
		}
		fmt.Fprintf(&b, "<li>%s", r.inline(strings.Join(item, " ")))
		lists[len(lists)-1].itemOpen = true
		item = nil
	}
	flushPara := func() {
		if para == nil {
			return
		}
		fmt.Fprintf(&b, "<p>%s</p>\n", r.inline(strings.Join(para, " ")))
		para = nil
	}
	flushQuote := func() {
		if quote == nil {
			return
		}
		fmt.Fprintf(&b, "<p>%s</p>\n", r.inline(strings.Join(quote, " ")))
		quote = nil
	}
	closeTable := func() {
		if inTable {
			b.WriteString("</table></div>\n")
			inTable = false
		}
	}
	closeQuote := func() {
		if inQuote {
			flushQuote()
			b.WriteString("</blockquote>\n")
			inQuote = false
		}
	}

	// closeTop closes the innermost open list, emitting any pending item
	// first. The level below keeps its own item open: a nested list lives
	// inside its parent's <li>.
	closeTop := func() {
		flushItem()
		top := &lists[len(lists)-1]
		if top.itemOpen {
			b.WriteString("</li>\n")
		}
		if top.ordered {
			b.WriteString("</ol>\n")
		} else {
			b.WriteString("</ul>\n")
		}
		lists = lists[:len(lists)-1]
	}
	closeLists := func() {
		for len(lists) > 0 {
			closeTop()
		}
	}
	closeAll := func() {
		closeTable()
		closeLists()
		flushPara()
		closeQuote()
	}

	// startItem opens (or re-levels) the list stack for an item at the given
	// indent and makes its first line the pending item text.
	startItem := func(indent int, ordered bool, content string) {
		closeTable()
		flushPara()
		closeQuote()
		flushItem() // the previous item's text, before any level change
		for len(lists) > 0 && lists[len(lists)-1].indent > indent {
			closeTop()
		}
		if len(lists) > 0 && lists[len(lists)-1].indent == indent {
			if lists[len(lists)-1].ordered != ordered {
				closeTop() // same level, different kind of list
			} else if lists[len(lists)-1].itemOpen {
				b.WriteString("</li>\n")
				lists[len(lists)-1].itemOpen = false
			}
		}
		if len(lists) == 0 || lists[len(lists)-1].indent < indent {
			if ordered {
				b.WriteString("<ol>\n")
			} else {
				b.WriteString("<ul>\n")
			}
			lists = append(lists, listState{indent: indent, ordered: ordered})
		}
		item = []string{content}
	}

	for i := 0; i < len(lines); i++ {
		raw := strings.TrimRight(lines[i], "\r")
		trimmed := strings.TrimSpace(raw)
		indent := len(raw) - len(strings.TrimLeft(raw, " \t"))

		// Fenced code block: copy verbatim to the closing fence.
		if strings.HasPrefix(trimmed, "```") {
			closeAll()
			lang := strings.TrimSpace(strings.TrimPrefix(trimmed, "```"))
			if lang != "" {
				fmt.Fprintf(&b, "<pre data-lang=\"%s\"><code>", template.HTMLEscapeString(lang))
			} else {
				b.WriteString("<pre><code>")
			}
			for i++; i < len(lines); i++ {
				if strings.HasPrefix(strings.TrimSpace(lines[i]), "```") {
					break
				}
				b.WriteString(template.HTMLEscapeString(strings.TrimRight(lines[i], "\r")))
				b.WriteString("\n")
			}
			b.WriteString("</code></pre>\n")
			continue
		}

		switch {
		case trimmed == "":
			closeAll()

		case trimmed == "---" || trimmed == "***" || trimmed == "___":
			closeAll()
			b.WriteString("<hr>\n")

		case strings.HasPrefix(trimmed, "#"):
			closeAll()
			level := len(trimmed) - len(strings.TrimLeft(trimmed, "#"))
			if level > 4 {
				level = 4
			}
			text := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
			fmt.Fprintf(&b, "<h%d id=\"%s\">%s</h%d>\n", level, slug(text), r.inline(text), level)

		case strings.HasPrefix(trimmed, "|"):
			cells := splitRow(trimmed)
			if isSeparator(cells) {
				continue
			}
			tag := "td"
			if !inTable {
				closeAll()
				b.WriteString("<div class=\"table-scroll\"><table>\n")
				inTable = true
				tag = "th"
			}
			b.WriteString("<tr>")
			for _, c := range cells {
				fmt.Fprintf(&b, "<%s>%s</%s>", tag, r.inline(c), tag)
			}
			b.WriteString("</tr>\n")

		case strings.HasPrefix(trimmed, "- "), strings.HasPrefix(trimmed, "* "), strings.HasPrefix(trimmed, "+ "):
			startItem(indent, false, trimmed[2:])

		case orderedRe.MatchString(trimmed):
			g := orderedRe.FindStringSubmatch(trimmed)
			startItem(indent, true, g[2])

		case strings.HasPrefix(trimmed, ">"):
			closeTable()
			closeLists()
			flushPara()
			if !inQuote {
				b.WriteString("<blockquote>\n")
				inQuote = true
			}
			line := strings.TrimSpace(strings.TrimPrefix(trimmed, ">"))
			switch {
			case line == "":
				flushQuote()
			case strings.HasPrefix(line, "#"):
				// A heading inside a blockquote still carries its anchor:
				// documents link to them (README's "Honest status" note).
				flushQuote()
				text := strings.TrimSpace(strings.TrimLeft(line, "#"))
				fmt.Fprintf(&b, "<p id=\"%s\"><strong>%s</strong></p>\n", slug(text), r.inline(text))
			case strings.HasPrefix(line, "- "), strings.HasPrefix(line, "* "):
				flushQuote()
				fmt.Fprintf(&b, "<p>&bull; %s</p>\n", r.inline(line[2:]))
			default:
				quote = append(quote, line)
			}

		default:
			// A continuation line indented under a pending list item belongs
			// to that item, not to a new paragraph.
			if item != nil && indent > lists[len(lists)-1].indent {
				item = append(item, trimmed)
				continue
			}
			if inTable || len(lists) > 0 || inQuote {
				closeAll()
			}
			para = append(para, trimmed)
		}
	}
	closeAll()
	return template.HTML(b.String())
}

// --- rendering ---

type stamp struct {
	Generated string
	Commit    string
}

func footerStamp() stamp {
	commit := os.Getenv("GITHUB_SHA")
	if len(commit) > 12 {
		commit = commit[:12]
	}
	return stamp{
		Generated: time.Now().UTC().Format("2006-01-02 15:04 UTC"),
		Commit:    commit,
	}
}

// navPage / navSection are the site navigation rendered into every page.
type navPage struct {
	Page    string
	Title   string
	Summary string
}

type navSection struct {
	Title string
	Intro string
	Pages []navPage
}

// chrome is the per-site furniture every page shares.
type chrome struct {
	stamp
	SiteTitle   string
	Tagline     string
	Repo        string
	Branch      string
	Nav         []navSection
	Home        string // the site's index page
	Conformance string // where the conformance dashboard lives
	pages       map[string]string
}

func newChrome(sm *siteMap, st stamp) chrome {
	ch := chrome{
		stamp:       st,
		SiteTitle:   "zxplay_go conformance",
		Conformance: "conformance.html",
		Home:        "index.html",
		Repo:        "https://github.com/stever/zxcode",
		Branch:      "main",
		pages:       map[string]string{},
	}
	if sm == nil {
		return ch
	}
	if sm.Title != "" {
		ch.SiteTitle = sm.Title
	}
	ch.Tagline = sm.Tagline
	if sm.Repo != "" {
		ch.Repo = sm.Repo
	}
	if sm.Branch != "" {
		ch.Branch = sm.Branch
	}
	for _, sec := range sm.Sections {
		ns := navSection{Title: sec.Title, Intro: sec.Intro}
		for _, p := range sec.Pages {
			ns.Pages = append(ns.Pages, navPage{Page: p.Page, Title: p.Title, Summary: p.Summary})
			if p.Source != "" {
				ch.pages[path.Clean(p.Source)] = p.Page
			}
			if p.Home {
				ch.Home = p.Page
			}
		}
		ch.Nav = append(ch.Nav, ns)
	}
	return ch
}

// Link resolves a repo-relative markdown path to the site page publishing
// it, falling back to the file on GitHub when the site does not include it.
// Templates use it so a hard-coded cross-reference follows the site map
// rather than always leaving for GitHub.
func (ch chrome) Link(source string) string {
	if p, ok := ch.pages[path.Clean(source)]; ok {
		return p
	}
	return ch.Repo + "/blob/" + ch.Branch + "/" + source
}

// renderer builds the docRenderer for a source file (or a generated page,
// which has no source directory and therefore no relative links to rewrite).
func (ch chrome) renderer(source string) *docRenderer {
	dir := ""
	if source != "" {
		dir = path.Dir(path.Clean(source))
		if dir == "." {
			dir = ""
		}
	}
	return &docRenderer{dir: dir, pages: ch.pages, repo: ch.Repo, branch: ch.Branch}
}

type areaGroup struct {
	Area    string
	Entries []entry
}

type PageData struct {
	chrome
	Title   string
	Current string
}

type indexData struct {
	PageData
	Counts map[string]int
	Order  []string
	Areas  []areaGroup
	Gaps   []mdTable
}

type suiteData struct {
	PageData
	Suite suite
}

type docData struct {
	PageData
	Body template.HTML
	TOC  []tocEntry
}

type tocEntry struct {
	Anchor string
	Text   string
}

type homeData struct {
	PageData
	Body template.HTML
}

func renderIndex(outDir string, m *manifest, gaps []mdTable, ch chrome) error {
	counts := map[string]int{}
	var areas []areaGroup
	index := map[string]int{}
	for _, e := range m.Entries {
		counts[e.Status]++
		i, ok := index[e.Area]
		if !ok {
			i = len(areas)
			index[e.Area] = i
			areas = append(areas, areaGroup{Area: e.Area})
		}
		areas[i].Entries = append(areas[i].Entries, e)
	}
	f, err := os.Create(filepath.Join(outDir, ch.Conformance))
	if err != nil {
		return err
	}
	defer f.Close()
	return tmpl.ExecuteTemplate(f, "index", indexData{
		PageData: PageData{chrome: ch, Title: "Conformance dashboard", Current: ch.Conformance},
		Counts:   counts,
		Order:    []string{"pass", "known-gap", "partial", "manual", "skip", "not run", "planned", "fail"},
		Areas:    areas,
		Gaps:     gaps,
	})
}

func renderSuite(outDir string, s suite, ch chrome) error {
	if s.Page == "" {
		return fmt.Errorf("suite %s has no page", s.ID)
	}
	f, err := os.Create(filepath.Join(outDir, s.Page))
	if err != nil {
		return err
	}
	defer f.Close()
	return tmpl.ExecuteTemplate(f, "suite", suiteData{
		PageData: PageData{chrome: ch, Title: s.Title, Current: s.Page},
		Suite:    s,
	})
}

// headingRe finds the rendered h2 anchors for a page's table of contents.
var headingRe = regexp.MustCompile(`<h2 id="([^"]+)">(.*?)</h2>`)
var tagRe = regexp.MustCompile(`<[^>]+>`)

func tableOfContents(body string) []tocEntry {
	var toc []tocEntry
	for _, m := range headingRe.FindAllStringSubmatch(body, -1) {
		text := strings.TrimSpace(tagRe.ReplaceAllString(m[2], ""))
		if text == "" {
			continue
		}
		toc = append(toc, tocEntry{Anchor: m[1], Text: text})
	}
	return toc
}

// renderDoc renders a markdown file as a site page. sourcePath, when given,
// is the repo-relative path of the markdown (used for link rewriting and
// for the "edit this page" footer link).
func renderDoc(outDir, page, title, mdPath string, ch chrome, source *sitePage) error {
	data, err := os.ReadFile(mdPath)
	if err != nil {
		return err
	}
	rel := ""
	if source != nil {
		rel = source.Source
	}
	body := string(ch.renderer(rel).mdToHTML(string(data)))
	f, err := os.Create(filepath.Join(outDir, page))
	if err != nil {
		return err
	}
	defer f.Close()
	d := docData{
		PageData: PageData{chrome: ch, Title: title, Current: page},
		Body:     template.HTML(body),
		TOC:      tableOfContents(body),
	}
	return tmpl.ExecuteTemplate(f, "doc", d)
}

// renderSite renders every markdown page in the site map. The home page
// additionally gets the section index appended, so the landing page always
// lists what the site holds even as pages are added.
func renderSite(outDir, root string, sm *siteMap, ch chrome) error {
	for _, sec := range sm.Sections {
		for _, p := range sec.Pages {
			if p.Generated {
				continue
			}
			src := filepath.Join(root, filepath.FromSlash(p.Source))
			if _, err := os.Stat(src); err != nil {
				return fmt.Errorf("page %s: %w", p.Page, err)
			}
			if p.Home {
				if err := renderHome(outDir, src, p, ch); err != nil {
					return fmt.Errorf("home %s: %w", p.Page, err)
				}
				continue
			}
			page := p
			if err := renderDoc(outDir, p.Page, p.Title, src, ch, &page); err != nil {
				return fmt.Errorf("page %s: %w", p.Page, err)
			}
		}
	}
	return nil
}

func renderHome(outDir, src string, p sitePage, ch chrome) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	page := p
	body := ch.renderer(page.Source).mdToHTML(string(data))
	f, err := os.Create(filepath.Join(outDir, p.Page))
	if err != nil {
		return err
	}
	defer f.Close()
	return tmpl.ExecuteTemplate(f, "home", homeData{
		PageData: PageData{chrome: ch, Title: p.Title, Current: p.Page},
		Body:     body,
	})
}

var tmpl = template.Must(template.New("").Funcs(template.FuncMap{
	"badgeClass": func(s string) string {
		switch s {
		case "pass":
			return "pass"
		case "fail":
			return "fail"
		case "skip", "not run":
			return "skip"
		case "planned":
			return "planned"
		case "manual":
			return "manual"
		default:
			return "other"
		}
	},
}).Parse(`
{{define "head"}}<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}} · {{.SiteTitle}}</title>
<style>
:root { color-scheme: light dark; --rule: #8884; --accent: #2b7; }
* { box-sizing: border-box; }
body { font: 15px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; }
.shell { display: grid; grid-template-columns: 16rem minmax(0, 1fr); gap: 2.5rem; max-width: 82rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
main { min-width: 0; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 1rem; }
h2 { font-size: 1.25rem; margin-top: 2.2rem; padding-bottom: 0.2rem; border-bottom: 1px solid var(--rule); }
h3 { font-size: 1.05rem; margin-top: 1.6rem; }
h4 { font-size: 0.95rem; margin-top: 1.2rem; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.8; }
a { color: inherit; }
code { font-size: 0.9em; background: #8881; padding: 0.05rem 0.3rem; border-radius: 0.25rem; }
pre { background: #8881; border: 1px solid var(--rule); border-radius: 0.4rem; padding: 0.7rem 0.9rem; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 0.85em; line-height: 1.45; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; }
th, td { border: 1px solid var(--rule); padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #8881; }
.table-scroll { overflow-x: auto; max-width: 100%; }
.badge { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 0.6rem; font-size: 0.85em; white-space: nowrap; }
.pass { background: #2a4; color: #fff; } .fail { background: #c33; color: #fff; }
.skip { background: #888; color: #fff; } .planned { background: #46c; color: #fff; }
.other { background: #a80; color: #fff; }
.manual { background: #75a; color: #fff; }
.summary span { margin-right: 1rem; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-size: 0.85em; opacity: 0.7; }
.muted { opacity: 0.75; font-size: 0.9em; }
blockquote { border-left: 3px solid var(--accent); margin: 1rem 0; padding: 0.1rem 0.9rem; background: #8881; border-radius: 0 0.3rem 0.3rem 0; }
blockquote p { margin: 0.5rem 0; }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2rem 0; }
sidebar, .sidebar { font-size: 0.9em; }
.sidebar .brand { font-weight: 600; font-size: 1.05rem; display: block; text-decoration: none; margin-bottom: 0.2rem; }
.sidebar .tagline { opacity: 0.7; font-size: 0.85em; margin-bottom: 1.2rem; }
.sidebar h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; border: 0; margin: 1.4rem 0 0.4rem; padding: 0; }
.sidebar ul { list-style: none; margin: 0; padding: 0; }
.sidebar li { margin: 0.15rem 0; }
.sidebar a { text-decoration: none; display: block; padding: 0.15rem 0.5rem; border-radius: 0.25rem; border-left: 2px solid transparent; }
.sidebar a:hover { background: #8881; }
.sidebar a.current { border-left-color: var(--accent); background: #8881; font-weight: 600; }
.toc { border: 1px solid var(--rule); border-radius: 0.4rem; padding: 0.6rem 1rem; margin: 1.5rem 0; font-size: 0.9em; }
.toc strong { display: block; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; margin-bottom: 0.3rem; }
.toc ul { margin: 0; padding-left: 1.1rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 0.8rem; margin: 1rem 0 2rem; }
.card { border: 1px solid var(--rule); border-radius: 0.4rem; padding: 0.7rem 0.9rem; text-decoration: none; display: block; }
.card:hover { border-color: var(--accent); }
.card b { display: block; margin-bottom: 0.2rem; }
.card span { font-size: 0.88em; opacity: 0.75; }
@media (max-width: 60rem) {
  .shell { grid-template-columns: minmax(0, 1fr); gap: 1rem; }
  /* Stacked above the content, the full nav would push every page below
     the fold; cap it and let it scroll on its own. */
  .sidebar { border-bottom: 1px solid var(--rule); padding-bottom: 1rem; max-height: 40vh; overflow-y: auto; }
}
</style>
</head>
<body>
<div class="shell">
<nav class="sidebar">
<a class="brand" href="{{.Home}}">{{.SiteTitle}}</a>
{{if .Tagline}}<div class="tagline">{{.Tagline}}</div>{{end}}
{{range .Nav}}<h2>{{.Title}}</h2>
<ul>{{range .Pages}}<li><a href="{{.Page}}"{{if eq .Page $.Current}} class="current"{{end}}>{{.Title}}</a></li>{{end}}</ul>
{{end}}
</nav>
<main>{{end}}

{{define "foot"}}<footer>Generated {{.Generated}}{{if .Commit}} from commit {{.Commit}}{{end}} by <code>conformance/confgen</code>.
This site is built from markdown in the <a href="{{.Repo}}">zxcode repository</a> — edit the source, not the page.</footer>
</main>
</div>
</body>
</html>{{end}}

{{define "home"}}{{template "head" .PageData}}
{{.Body}}
{{range .Nav}}
<h2 id="{{.Title}}">{{.Title}}</h2>
{{if .Intro}}<p class="muted">{{.Intro}}</p>{{end}}
<div class="cards">
{{range .Pages}}<a class="card" href="{{.Page}}"><b>{{.Title}}</b>{{if .Summary}}<span>{{.Summary}}</span>{{end}}</a>{{end}}
</div>
{{end}}
{{template "foot" .}}{{end}}

{{define "index"}}{{template "head" .PageData}}
<h1>zxplay_go — conformance dashboard</h1>
<p>Live conformance of the <a href="{{.Repo}}/tree/{{.Branch}}/packages/emulator-core/zxplay_go">zxplay_go emulation core</a>
against its oracles and the external ZX Spectrum Next test suites.
Generated from the manifest and the actual test run on every publish — do not edit by hand.
Background: <a href="{{.Link "packages/emulator-core/zxplay_go/docs/architecture/known-gaps.md"}}">known-gaps register</a>
· <a href="{{.Link "packages/emulator-core/zxplay_go/docs/architecture/next-fpga.md"}}">Next FPGA emulation docs</a>
· <a href="vhdl.html">VHDL conformance matrix</a>.</p>

<h2 id="summary">Summary</h2>
<p class="summary">{{range .Order}}{{if index $.Counts .}}<span><span class="badge {{badgeClass .}}">{{.}}</span> {{index $.Counts .}}</span> {{end}}{{end}}</p>

{{range .Areas}}
<h2 id="{{.Area}}">{{.Area}}</h2>
<div class="table-scroll"><table>
<tr><th>Check</th><th>Kind</th><th>Status</th><th>Oracle / tracking</th></tr>
{{range .Entries}}
<tr>
<td>{{if .Link}}<a href="{{.Link}}">{{.Title}}</a>{{else}}{{.Title}}{{end}}{{if .Notes}}<div class="muted">{{.Notes}}</div>{{end}}</td>
<td>{{.Kind}}</td>
<td><span class="badge {{badgeClass .Status}}">{{.Status}}</span></td>
<td>{{.Oracle}}{{if .Roadmap}}{{if .Oracle}} · {{end}}roadmap: {{.Roadmap}}{{end}}{{if .Detail}} · <a href="{{.Detail}}">breakdown</a>{{end}}</td>
</tr>
{{end}}
</table></div>
{{end}}

{{if .Gaps}}
<h2 id="known-gaps-and-simplifications">Known gaps and simplifications</h2>
<p class="muted">Rendered from <code>docs/architecture/known-gaps.md</code> — the hand-maintained register of deliberate
differences from real hardware. Rows link work to the roadmap via the statuses and sources recorded there.</p>
{{range .Gaps}}
<h3>{{.Heading}}</h3>
<div class="table-scroll"><table>
<tr>{{range .Headers}}<th>{{.}}</th>{{end}}</tr>
{{range .Rows}}<tr>{{range .}}<td>{{.}}</td>{{end}}</tr>{{end}}
</table></div>
{{end}}
{{end}}
{{template "foot" .}}{{end}}

{{define "suite"}}{{template "head" .PageData}}
<p class="muted"><a href="{{.Conformance}}">← conformance dashboard</a></p>
<h1>{{.Suite.Title}}</h1>
<p>{{.Suite.Description}} Upstream: <a href="{{.Suite.Link}}">{{.Suite.Link}}</a>.</p>
{{range .Suite.Groups}}
<h2 id="{{.Name}}">{{.Name}}</h2>
<div class="table-scroll"><table>
<tr><th>Test</th><th>Status</th><th>Notes</th></tr>
{{range .Tests}}
<tr>
<td>{{if .Path}}<a href="{{.Path}}">{{.Name}}</a>{{else}}{{.Name}}{{end}}</td>
<td><span class="badge {{badgeClass .Status}}">{{.Status}}</span></td>
<td>{{.Notes}}</td>
</tr>
{{end}}
</table></div>
{{end}}
{{template "foot" .}}{{end}}

{{define "doc"}}{{template "head" .PageData}}
{{if .TOC}}<div class="toc"><strong>On this page</strong><ul>{{range .TOC}}<li><a href="#{{.Anchor}}">{{.Text}}</a></li>{{end}}</ul></div>{{end}}
{{.Body}}
{{template "foot" .}}{{end}}
`))
