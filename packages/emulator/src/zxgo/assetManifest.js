// Content-hash cache-busting for runtime-fetched assets.
//
// A build step writes /asset-manifest.json mapping each servable /dist and
// /next path to a short content hash; runtime URLs append ?v=<hash>, so a
// changed file always gets a fresh URL while unchanged files stay cacheable.
// The manifest itself is served no-cache (see the app Caddyfiles), so a new
// build's hashes are picked up on the next page load. Assets whose URLs are
// emitted into the HTML (bundle.js, main.css) use content-hashed FILENAMES
// instead and never go through here.
//
// Unknown paths fall back to the bare path: that covers dev (no manifest built)
// and any asset added before the manifest is regenerated.

let manifestPromise = null;

function loadManifest(base) {
    if (!manifestPromise) {
        manifestPromise = fetch(new URL('/asset-manifest.json', base))
            .then((r) => (r.ok ? r.json() : {}))
            .catch(() => ({}));
    }
    return manifestPromise;
}

// Resolve a root-absolute asset path (e.g. '/dist/zx.wasm', '/next/tbblue.mmc')
// to a content-versioned absolute URL. `base` fixes the origin/manifest
// location — pass the emulator script URL so it stays correct when the engine
// is embedded cross-origin; it defaults to the current document.
export async function assetUrl(path, base = window.location.href) {
    const manifest = await loadManifest(base);
    const hash = manifest[path];
    return new URL(hash ? `${path}?v=${hash}` : path, base).href;
}
