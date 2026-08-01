# Conformance dashboard

Live documentation of the emulator's conformance to its oracles and to
the external ZX Spectrum Next test suites, published to GitHub Pages by
`.github/workflows/pages.yml` (repo root) on every push to main that
touches the emulator or the documentation. The published page is
GENERATED — never edit site output by hand; change the inputs instead.

The dashboard is one section of the wider ZX Play documentation site,
which the same tool builds. The site map and its conventions are
documented in `docs/README.md` at the repo root; this file covers the
conformance inputs only.

## How it fits together

- `manifest.json` — the machine-readable source of truth. Two sections:
  `entries` (one per conformance check on the dashboard; a `runner`
  resolves live status from the actual `go test -json` run, otherwise an
  explicit `status` applies) and `suites` (per-suite breakdown pages
  listing every test in an external suite, same status rules per test).
  An entry's `detail` field links it to its breakdown page.
- `confgen/` — a zero-dependency Go tool (its own module, so it adds
  nothing to the emulator's go.mod) that merges the manifest, the test
  results, `docs/architecture/known-gaps.md`, and `VHDL_CONFORMANCE.md`
  into the dashboard (`conformance.html`), one page per suite
  (`z80test.html`, `nexttests.html`, `327tests.html`), and `vhdl.html`
  (the matrix document rendered per axis) — alongside the documentation
  pages named by `docs/site.json`.
- The known-gaps register and the VHDL matrix are rendered as-is, so
  both stay single-sourced in their markdown files.

Run locally — the conformance pages on their own, without the docs site
(the dashboard then takes `index.html`, as it did before the site
existed):

```
cd conformance/confgen
go test -json -count=1 ../../...  > /tmp/gotest.json || true
go run . -manifest ../manifest.json -results /tmp/gotest.json \
  -gaps ../../docs/architecture/known-gaps.md \
  -vhdl ../../VHDL_CONFORMANCE.md -out /tmp/site
```

Add `-site ../../../../../docs/site.json -root ../../../../..` to build
the full site as it is published.

## Manifest schema

```json
{
  "entries": [
    {
      "id": "unique-slug",
      "title": "human-readable name",
      "area": "grouping heading on the page",
      "kind": "internal | external | manual",
      "oracle": "what proves it (VHDL module, exerciser, ...)",
      "runner": { "package": "go package path", "tests": ["TestName"] },
      "status": "only for entries WITHOUT a runner",
      "roadmap": "where follow-up work is tracked (e.g. ZX Play #137)",
      "link": "optional URL",
      "notes": "optional detail shown under the title"
    }
  ]
}
```

Suites section (`suites`): each suite has `id`, `title`, `page` (output
file name), `link`, `description`, and `groups` of tests
(`{name, path, status | runner, notes}`). Tests start as `planned` and
flip to a `runner` as they are wired into the harness.

Status resolution for runner entries: any `fail` wins, then `not run`
(the test never appeared in the stream — usually a renamed test, fix the
manifest), then `skip` (gated tests without staged assets), then `pass`.

## Maintenance rules (people and agents)

- Renaming or adding a golden/conformance test → update the matching
  manifest entry in the same change.
- Integrating an external suite (work item #137 on the ZX Play board) →
  flip its entry from `planned` to a runner as tests land, one entry per
  suite group.
- Closing or accepting a hardware gap → edit
  `docs/architecture/known-gaps.md`; the page picks it up automatically.
- The dashboard exists to answer "where is this issue on the roadmap":
  keep `roadmap` fields pointing at the current tracking item.
