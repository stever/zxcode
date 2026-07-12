// confgen renders the zx_go conformance dashboard (a static HTML page)
// from three inputs: the conformance manifest, a `go test -json` result
// stream, and the known-gaps register in docs/architecture. The output is
// published to GitHub Pages by .github/workflows/conformance-pages.yml;
// it is generated, never hand-edited.
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
	Notes   string  `json:"notes"`
	Runner  *runner `json:"runner"`
}

type manifest struct {
	Entries []entry `json:"entries"`
}

// testEvent is the subset of the test2json stream confgen consumes.
type testEvent struct {
	Action  string `json:"Action"`
	Package string `json:"Package"`
	Test    string `json:"Test"`
}

// gapTable is one markdown table from known-gaps.md with the heading it
// appeared under.
type gapTable struct {
	Heading string
	Headers []string
	Rows    [][]string
}

func main() {
	manifestPath := flag.String("manifest", "manifest.json", "conformance manifest")
	resultsPath := flag.String("results", "", "go test -json output (optional)")
	gapsPath := flag.String("gaps", "", "known-gaps.md to render (optional)")
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

	var gaps []gapTable
	if *gapsPath != "" {
		gaps, err = loadGaps(*gapsPath)
		if err != nil {
			log.Fatalf("gaps: %v", err)
		}
	}

	resolve(m.Entries, results)

	if err := render(*outDir, m.Entries, gaps); err != nil {
		log.Fatalf("render: %v", err)
	}
	fmt.Printf("wrote %s\n", filepath.Join(*outDir, "index.html"))
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

// resolve fills each runner-backed entry's status from the results:
// any fail wins, then skip, then pass; absent results read "not run".
func resolve(entries []entry, results map[string]string) {
	for i := range entries {
		e := &entries[i]
		if e.Runner == nil {
			if e.Status == "" {
				e.Status = "planned"
			}
			continue
		}
		status := ""
		for _, t := range e.Runner.Tests {
			got, ok := results[e.Runner.Package+"/"+t]
			if !ok {
				got = "not run"
			}
			status = worse(status, got)
		}
		e.Status = status
	}
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

// loadGaps extracts every markdown table from known-gaps.md along with
// the nearest heading above it. Only paths, pipes and headings are
// interpreted; everything else passes through as text.
func loadGaps(path string) ([]gapTable, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var tables []gapTable
	heading := ""
	var current *gapTable
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
				tables = append(tables, gapTable{Heading: heading, Headers: cells})
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

type areaGroup struct {
	Area    string
	Entries []entry
}

type pageData struct {
	Generated string
	Commit    string
	Counts    map[string]int
	Order     []string
	Areas     []areaGroup
	Gaps      []gapTable
}

func render(outDir string, entries []entry, gaps []gapTable) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	// .nojekyll stops GitHub Pages from routing the artifact through
	// Jekyll (which would drop nothing here, but is wasted work).
	if err := os.WriteFile(filepath.Join(outDir, ".nojekyll"), nil, 0o644); err != nil {
		return err
	}

	counts := map[string]int{}
	var areas []areaGroup
	index := map[string]int{}
	for _, e := range entries {
		counts[e.Status]++
		i, ok := index[e.Area]
		if !ok {
			i = len(areas)
			index[e.Area] = i
			areas = append(areas, areaGroup{Area: e.Area})
		}
		areas[i].Entries = append(areas[i].Entries, e)
	}

	commit := os.Getenv("GITHUB_SHA")
	if len(commit) > 12 {
		commit = commit[:12]
	}
	data := pageData{
		Generated: time.Now().UTC().Format("2006-01-02 15:04 UTC"),
		Commit:    commit,
		Counts:    counts,
		Order:     []string{"pass", "known-gap", "partial", "skip", "not run", "planned", "fail"},
		Areas:     areas,
		Gaps:      gaps,
	}

	f, err := os.Create(filepath.Join(outDir, "index.html"))
	if err != nil {
		return err
	}
	defer f.Close()
	return page.Execute(f, data)
}

var page = template.Must(template.New("page").Funcs(template.FuncMap{
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
		default:
			return "other"
		}
	},
}).Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zx_go conformance</title>
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
.summary span { margin-right: 1rem; }
footer { margin-top: 3rem; font-size: 0.85em; opacity: 0.7; }
.muted { opacity: 0.75; font-size: 0.9em; }
</style>
</head>
<body>
<h1>zx_go emulator — conformance dashboard</h1>
<p>Live conformance of the <a href="https://github.com/stever/zxcode/tree/main/packages/emulator-core/zx_go">zx_go emulation core</a>
against its oracles and the external ZX Spectrum Next test suites.
Generated from the manifest and the actual test run on every publish — do not edit by hand.
Background: <a href="https://github.com/stever/zxcode/blob/main/packages/emulator-core/zx_go/docs/architecture/known-gaps.md">known-gaps register</a>
· <a href="https://github.com/stever/zxcode/blob/main/packages/emulator-core/zx_go/docs/architecture/next-fpga.md">Next FPGA emulation docs</a>
· <a href="https://github.com/stever/zxcode/blob/main/packages/emulator-core/zx_go/VHDL_CONFORMANCE.md">VHDL conformance matrix</a>.</p>

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
<td>{{.Oracle}}{{if .Roadmap}}{{if .Oracle}} · {{end}}roadmap: {{.Roadmap}}{{end}}</td>
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

<footer>Generated {{.Generated}}{{if .Commit}} from commit {{.Commit}}{{end}} by conformance/confgen.
Manifest: <a href="https://github.com/stever/zxcode/blob/main/packages/emulator-core/zx_go/conformance/manifest.json">conformance/manifest.json</a>.</footer>
</body>
</html>
`))
