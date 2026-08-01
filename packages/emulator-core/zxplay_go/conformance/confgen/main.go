// confgen renders the zxplay_go conformance dashboard (a static site) from
// four inputs: the conformance manifest (entries + per-suite breakdowns),
// a `go test -json` result stream, the known-gaps register, and the VHDL
// conformance matrix document. The output is published to GitHub Pages by
// .github/workflows/conformance-pages.yml; it is generated, never
// hand-edited.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"html/template"
	"log"
	"os"
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

func main() {
	manifestPath := flag.String("manifest", "manifest.json", "conformance manifest")
	resultsPath := flag.String("results", "", "go test -json output (optional)")
	gapsPath := flag.String("gaps", "", "known-gaps.md to render (optional)")
	vhdlPath := flag.String("vhdl", "", "VHDL_CONFORMANCE.md to render as vhdl.html (optional)")
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

	stamp := footerStamp()

	if err := renderIndex(*outDir, m, gaps, stamp); err != nil {
		log.Fatalf("index: %v", err)
	}
	for _, s := range m.Suites {
		if err := renderSuite(*outDir, s, stamp); err != nil {
			log.Fatalf("suite %s: %v", s.ID, err)
		}
	}
	if *vhdlPath != "" {
		if err := renderDoc(*outDir, "vhdl.html", "VHDL conformance matrix", *vhdlPath, stamp); err != nil {
			log.Fatalf("vhdl: %v", err)
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

// --- minimal markdown → HTML for the VHDL matrix page ---

var (
	linkRe = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)\)`)
	codeRe = regexp.MustCompile("`([^`]+)`")
	boldRe = regexp.MustCompile(`\*\*([^*]+)\*\*`)
)

func inline(s string) template.HTML {
	s = template.HTMLEscapeString(s)
	s = linkRe.ReplaceAllString(s, `<a href="$2">$1</a>`)
	s = codeRe.ReplaceAllString(s, `<code>$1</code>`)
	s = boldRe.ReplaceAllString(s, `<strong>$1</strong>`)
	return template.HTML(s)
}

// mdToHTML converts the subset of markdown these documents use: ATX
// headings, pipe tables, dash lists, blockquotes, paragraphs, and the
// inline forms above. Anything fancier passes through as escaped text.
func mdToHTML(src string) template.HTML {
	var b strings.Builder
	lines := strings.Split(src, "\n")
	inTable, inList, inPara := false, false, false
	closeAll := func() {
		if inTable {
			b.WriteString("</table>\n")
			inTable = false
		}
		if inList {
			b.WriteString("</ul>\n")
			inList = false
		}
		if inPara {
			b.WriteString("</p>\n")
			inPara = false
		}
	}
	for i := 0; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		switch {
		case trimmed == "" || trimmed == "---":
			closeAll()
		case strings.HasPrefix(trimmed, "#"):
			closeAll()
			level := len(trimmed) - len(strings.TrimLeft(trimmed, "#"))
			if level > 4 {
				level = 4
			}
			text := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
			fmt.Fprintf(&b, "<h%d>%s</h%d>\n", level, inline(text), level)
		case strings.HasPrefix(trimmed, "|"):
			cells := splitRow(trimmed)
			if isSeparator(cells) {
				continue
			}
			tag := "td"
			if !inTable {
				closeAll()
				b.WriteString("<table>\n")
				inTable = true
				tag = "th"
			}
			b.WriteString("<tr>")
			for _, c := range cells {
				fmt.Fprintf(&b, "<%s>%s</%s>", tag, inline(c), tag)
			}
			b.WriteString("</tr>\n")
		case strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* "):
			if inTable || inPara {
				closeAll()
			}
			if !inList {
				b.WriteString("<ul>\n")
				inList = true
			}
			fmt.Fprintf(&b, "<li>%s</li>\n", inline(trimmed[2:]))
		case strings.HasPrefix(trimmed, ">"):
			closeAll()
			fmt.Fprintf(&b, "<blockquote>%s</blockquote>\n", inline(strings.TrimSpace(trimmed[1:])))
		default:
			if inTable || inList {
				closeAll()
			}
			if !inPara {
				b.WriteString("<p>")
				inPara = true
			} else {
				b.WriteString(" ")
			}
			b.WriteString(string(inline(trimmed)))
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

type areaGroup struct {
	Area    string
	Entries []entry
}

type indexData struct {
	stamp
	Counts map[string]int
	Order  []string
	Areas  []areaGroup
	Gaps   []mdTable
	VHDL   bool
}

type suiteData struct {
	stamp
	Suite suite
}

type docData struct {
	stamp
	Title string
	Body  template.HTML
}

func renderIndex(outDir string, m *manifest, gaps []mdTable, st stamp) error {
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
	f, err := os.Create(filepath.Join(outDir, "index.html"))
	if err != nil {
		return err
	}
	defer f.Close()
	return tmpl.ExecuteTemplate(f, "index", indexData{
		stamp:  st,
		Counts: counts,
		Order:  []string{"pass", "known-gap", "partial", "manual", "skip", "not run", "planned", "fail"},
		Areas:  areas,
		Gaps:   gaps,
	})
}

func renderSuite(outDir string, s suite, st stamp) error {
	if s.Page == "" {
		return fmt.Errorf("suite %s has no page", s.ID)
	}
	f, err := os.Create(filepath.Join(outDir, s.Page))
	if err != nil {
		return err
	}
	defer f.Close()
	return tmpl.ExecuteTemplate(f, "suite", suiteData{stamp: st, Suite: s})
}

func renderDoc(outDir, page, title, mdPath string, st stamp) error {
	data, err := os.ReadFile(mdPath)
	if err != nil {
		return err
	}
	f, err := os.Create(filepath.Join(outDir, page))
	if err != nil {
		return err
	}
	defer f.Close()
	return tmpl.ExecuteTemplate(f, "doc", docData{stamp: st, Title: title, Body: mdToHTML(string(data))})
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
<title>{{.}}</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.2rem; margin-top: 2rem; } h3 { font-size: 1rem; margin-top: 1.5rem; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; }
th, td { border: 1px solid #8884; padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #8881; }
.badge { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 0.6rem; font-size: 0.85em; white-space: nowrap; }
.pass { background: #2a4; color: #fff; } .fail { background: #c33; color: #fff; }
.skip { background: #888; color: #fff; } .planned { background: #46c; color: #fff; }
.other { background: #a80; color: #fff; }
.manual { background: #75a; color: #fff; }
.summary span { margin-right: 1rem; }
footer { margin-top: 3rem; font-size: 0.85em; opacity: 0.7; }
.muted { opacity: 0.75; font-size: 0.9em; }
nav { font-size: 0.9em; margin-bottom: 1rem; }
blockquote { border-left: 3px solid #8886; margin: 0.5rem 0; padding: 0.1rem 0.8rem; opacity: 0.85; }
</style>
</head>
<body>{{end}}

{{define "foot"}}<footer>Generated {{.Generated}}{{if .Commit}} from commit {{.Commit}}{{end}} by conformance/confgen.
Manifest: <a href="https://github.com/stever/zxcode/blob/main/packages/emulator-core/zxplay_go/conformance/manifest.json">conformance/manifest.json</a>.</footer>
</body>
</html>{{end}}

{{define "index"}}{{template "head" "zxplay_go conformance"}}
<h1>zxplay_go emulator — conformance dashboard</h1>
<p>Live conformance of the <a href="https://github.com/stever/zxcode/tree/main/packages/emulator-core/zxplay_go">zxplay_go emulation core</a>
against its oracles and the external ZX Spectrum Next test suites.
Generated from the manifest and the actual test run on every publish — do not edit by hand.
Background: <a href="https://github.com/stever/zxcode/blob/main/packages/emulator-core/zxplay_go/docs/architecture/known-gaps.md">known-gaps register</a>
· <a href="https://github.com/stever/zxcode/blob/main/packages/emulator-core/zxplay_go/docs/architecture/next-fpga.md">Next FPGA emulation docs</a>
· <a href="vhdl.html">VHDL conformance matrix</a>.</p>

<h2>Summary</h2>
<p class="summary">{{range .Order}}{{if index $.Counts .}}<span><span class="badge {{badgeClass .}}">{{.}}</span> {{index $.Counts .}}</span> {{end}}{{end}}</p>

{{range .Areas}}
<h2>{{.Area}}</h2>
<table>
<tr><th>Check</th><th>Kind</th><th>Status</th><th>Oracle / tracking</th></tr>
{{range .Entries}}
<tr>
<td>{{if .Link}}<a href="{{.Link}}">{{.Title}}</a>{{else}}{{.Title}}{{end}}{{if .Notes}}<div class="muted">{{.Notes}}</div>{{end}}</td>
<td>{{.Kind}}</td>
<td><span class="badge {{badgeClass .Status}}">{{.Status}}</span></td>
<td>{{.Oracle}}{{if .Roadmap}}{{if .Oracle}} · {{end}}roadmap: {{.Roadmap}}{{end}}{{if .Detail}} · <a href="{{.Detail}}">breakdown</a>{{end}}</td>
</tr>
{{end}}
</table>
{{end}}

{{if .Gaps}}
<h2>Known gaps and simplifications</h2>
<p class="muted">Rendered from <code>docs/architecture/known-gaps.md</code> — the hand-maintained register of deliberate
differences from real hardware. Rows link work to the roadmap via the statuses and sources recorded there.</p>
{{range .Gaps}}
<h3>{{.Heading}}</h3>
<table>
<tr>{{range .Headers}}<th>{{.}}</th>{{end}}</tr>
{{range .Rows}}<tr>{{range .}}<td>{{.}}</td>{{end}}</tr>{{end}}
</table>
{{end}}
{{end}}
{{template "foot" .}}{{end}}

{{define "suite"}}{{template "head" .Suite.Title}}
<nav><a href="index.html">← conformance dashboard</a></nav>
<h1>{{.Suite.Title}}</h1>
<p>{{.Suite.Description}} Upstream: <a href="{{.Suite.Link}}">{{.Suite.Link}}</a>.</p>
{{range .Suite.Groups}}
<h2>{{.Name}}</h2>
<table>
<tr><th>Test</th><th>Status</th><th>Notes</th></tr>
{{range .Tests}}
<tr>
<td>{{if .Path}}<a href="{{.Path}}">{{.Name}}</a>{{else}}{{.Name}}{{end}}</td>
<td><span class="badge {{badgeClass .Status}}">{{.Status}}</span></td>
<td>{{.Notes}}</td>
</tr>
{{end}}
</table>
{{end}}
{{template "foot" .}}{{end}}

{{define "doc"}}{{template "head" .Title}}
<nav><a href="index.html">← conformance dashboard</a></nav>
{{.Body}}
{{template "foot" .}}{{end}}
`))
