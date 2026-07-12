# Conformance dashboard

Live documentation of the emulator's conformance to its oracles and to
the external ZX Spectrum Next test suites, published to GitHub Pages by
`.github/workflows/conformance-pages.yml` (repo root) on every push to
main that touches the emulator. The published page is GENERATED — never
edit site output by hand; change the inputs instead.

## How it fits together

- `manifest.json` — the machine-readable source of truth: one entry per
  conformance check. Entries with a `runner` get their live status from
  the actual `go test -json` run; entries without one carry an explicit
  `status` (`planned`, `partial`, ...).
- `confgen/` — a zero-dependency Go tool (its own module, so it adds
  nothing to the emulator's go.mod) that merges the manifest, the test
  results, and `docs/architecture/known-gaps.md` into a static
  `index.html`.
- The known-gaps register is rendered onto the page as-is, so the gap
  tables and their statuses/sources stay single-sourced in
  `docs/architecture/known-gaps.md`.

Run locally:

```
cd conformance/confgen
go test -json -count=1 ../../...  > /tmp/gotest.json || true
go run . -manifest ../manifest.json -results /tmp/gotest.json \
  -gaps ../../docs/architecture/known-gaps.md -out /tmp/site
```

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
