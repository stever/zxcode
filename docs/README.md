# The documentation site

The published documentation site (GitHub Pages) is generated on every push
to `main` that touches `docs/**` or `packages/emulator-core/**`, by
`.github/workflows/pages.yml`. The generator is
`packages/emulator-core/zxplay_go/conformance/confgen` — a zero-dependency Go
tool in its own module, which also produces the conformance dashboard.

**Site output is generated. Never edit it — change the markdown.**

## What is on the site

Two kinds of page, both rendered from markdown:

- **Authored site pages**, in this directory. They document the published
  apps and the emulator's automation surface — material with no other home.
- **Documents that live where they are maintained**: the emulator's README,
  user manual, `DEBUGGER.md`, the architecture set, the known-gaps register
  and so on. The site renders them in place; it does not copy them, so there
  is exactly one copy of each to keep current.

Plus the generated conformance pages (dashboard, VHDL matrix, per-suite
inventories), which come from the manifest and the live test run.

## The site map

`site.json` is the whole structure: sections, and the pages in each. A page
is either

```json
{ "page": "automation.html", "title": "Automating the emulator",
  "source": "docs/emulator/automation.md", "summary": "one line for the home page" }
```

where `source` is repo-relative (so it can name any document in the tree), or

```json
{ "page": "conformance.html", "title": "Conformance dashboard", "generated": true }
```

for a page confgen writes elsewhere and only needs to show in the navigation.
Exactly one page carries `"home": true`; it becomes `index.html` and gets the
section index appended below its own content.

Adding a page means adding the markdown and one entry here. Nothing else.

## Links between documents

Relative links in the rendered markdown are rewritten:

- a link to a document the site publishes becomes that page (anchors kept),
- any other relative link becomes a link to the file on GitHub,
- images become raw GitHub URLs, so no assets need copying.

The upshot is that the same markdown reads correctly both on GitHub and on
the site, and no link silently dead-ends. Headings get GitHub-compatible
anchors, so `#a-heading-link` written for GitHub resolves on the site too.

## Building it locally

From `packages/emulator-core/zxplay_go/conformance/confgen`:

```bash
go run . \
  -manifest ../manifest.json \
  -gaps ../../docs/architecture/known-gaps.md \
  -vhdl ../../VHDL_CONFORMANCE.md \
  -site ../../../../../docs/site.json \
  -root ../../../../.. \
  -out /tmp/site
```

Then open `/tmp/site/index.html`. Add `-results /tmp/gotest.json` (from
`go test -json -count=1 ./... > /tmp/gotest.json`) to resolve live
conformance statuses; without it those rows read "not run".

Omitting `-site` reverts to the conformance dashboard alone, written as
`index.html` — the layout that existed before the docs site.

## Keeping it honest

The site describes the published apps and the emulator as they are. When a
change alters what a user sees — a new language in the IDE, a new automation
flag, a changed URL parameter, a debugger command — update the page that
covers it as part of that change. The emulator's own architecture docs have
their own update map in
`packages/emulator-core/zxplay_go/docs/architecture/README.md`.
