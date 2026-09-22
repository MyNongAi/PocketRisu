# Building `vendor/protonShare.mjs`

`protonShare.ts` is bundled to `server/node/vendor/protonShare.mjs`, which is
committed. The server loads that bundle; it never compiles this source at run
time.

## Why a bundle is required

`@protontech/crypto` publishes **TypeScript source only** — no `dist`, no `main`
field, and `.ts` import specifiers throughout. Node cannot load it directly, and
type-stripping does not help: the real blocker is export-condition resolution.
`openpgp/lightweight` is only reachable under the **`browser`** condition, and
Node has no runtime flag that remaps conditions.

Bundling resolves all of that ahead of time. `--conditions=browser` applies at
build time only — the emitted `.mjs` runs on plain Node with no special flags,
so nothing about how the server is launched has to change.

## Dependencies

Build-time only, not needed at run time:

- `@protontech/crypto` (**GPL-3.0** — PocketRisu is GPL-3.0, so this is fine)
- `esbuild`

`@protontech/drive-sdk` is *not* used. The endpoints it would have provided are
inlined here; see the flow comment at the top of `protonShare.ts`.

## Command

```
esbuild protonShare.ts \
  --bundle --platform=node --format=esm --conditions=browser \
  --outfile=../vendor/protonShare.mjs
```

Two things are load-bearing and must not be dropped:

- `--conditions=browser` — without it `openpgp/lightweight` fails to resolve.
- `import "@protontech/crypto/polyfill"` as the **first** import in the source;
  the library calls `Uint8Array.fromBase64`, which Node 24 lacks. The polyfill
  patches global prototypes, so `server.cjs` imports the bundle lazily and only
  when the feature is actually used.

Output is roughly 1.6 MB and the build takes a couple of minutes on Windows.

## Keep the manual path

Proton has announced a new cryptographic model for **late 2026 / early 2027**,
and says clients on the old model will stop interoperating. When this breaks,
the failure should degrade to "paste failed, download it yourself" rather than a
hard error — keep the existing manual import path for as long as this exists.
