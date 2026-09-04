# Exact module duplicate audit and recovery

## Verified scope (2026-09-04)

- Live read-only audit: **450 modules, 13 exact pairs, 13 duplicate copies**.
- All 450 records were comparable; no unverified/missing manifest was accepted.
- The 26 candidate identities had no direct ID references outside catalog/display metadata in `database/database.bin`.
- Another 14 live draft/plugin storage keys were checked without reading image/cache/backup payloads. No candidate IDs were found there.
- Dry run would leave **437 modules**. No live records or asset files were changed by this audit.
- Audited source SHA-256: `92c971992eb54b91af2919d2eff3cc1fd2f37a9b2f8abafb0ba787aec5e320db`.

The comparison excludes **only** module `id`, `folderId`, and `sourceInfo` (identity, catalog placement and import provenance). Every other field must match after stable object-key ordering, including full lore entries and flags, scripts, namespace, new display fields, and every asset tuple's name, count, sequence, path and extension. SHA-256 only indexes candidates; the complete signature strings are compared again. Asset bytes are not separately rehashed: matching paths refer to the same source address.

Lazy asset manifests are hydrated and validated against their owner, version, count, content hash and actual tuple payload before comparison. Missing/corrupt manifests or disagreement with inline assets make a record ineligible.

## Safety policy

Modules have **no native trash**, unlike characters. The maintenance tool removes duplicate **module records only**, keeps all asset binaries and manifests, and preserves an original database snapshot plus a module-only restoration archive.

Any global/character/chat/model-binding or literal script ID reference blocks the **whole duplicate group**. It does not silently replace two independently enabled modules with one or rewrite activation semantics. Folder membership and display recency alone do not count as runtime references. Computed module IDs, encrypted/compressed opaque plugin data and external systems cannot be proven reference-free by this audit. The absence of a direct reference is not a claim that arbitrary third-party code can never depend on the identity.

The tool supports the current uncompressed legacy v7 save format only. It fails closed for other formats; never convert a live database merely to run it.

## Commands

Run from the repository containing these tools. Stop the PocketRisu server and close all clients before **either apply or restore**. A server process must not retain an old in-memory database and later overwrite maintenance changes. The tool requires an explicit offline acknowledgement but does not itself stop/check processes.

1. Fresh read-only plan:

   ```powershell
   node tools/quarantine-exact-module-duplicates.cjs 'C:\Users\chae0_9ksma4k\PocketRisu\save\risuai.db'
   ```

2. Apply using that run's `sourceSha256`:

   ```powershell
   node tools/quarantine-exact-module-duplicates.cjs 'C:\Users\chae0_9ksma4k\PocketRisu\save\risuai.db' --apply --offline-confirmed --expected-sha '<fresh-sourceSha256>'
   ```

   `BEGIN IMMEDIATE`, source-hash recheck, full exact comparison, snapshot, archive, write and read-back verification form one transaction. A failure rolls it all back. Record the returned `archiveKey` and `backupKey`.

3. Module-only recovery, first dry run, then apply with the new source hash:

   ```powershell
   node tools/quarantine-exact-module-duplicates.cjs 'C:\Users\chae0_9ksma4k\PocketRisu\save\risuai.db' --restore '<archiveKey>'
   node tools/quarantine-exact-module-duplicates.cjs 'C:\Users\chae0_9ksma4k\PocketRisu\save\risuai.db' --restore '<archiveKey>' --apply --offline-confirmed --expected-sha '<fresh-sourceSha256>'
   ```

Recovery inserts only missing archived module IDs, rebuilds their folder membership, and preserves later unrelated imports, chats, settings and folder renames. A reused ID with different content stops recovery rather than overwriting it. Repeated recovery is idempotent. The original full snapshot is a last-resort safety copy, not the normal recovery route.

## Prior character trash guarantee

`tools/quarantine-exact-character-duplicates.cjs` compares all character definition fields, including full lorebooks and ordered asset references. It intentionally excludes local identity, chats/chat folders, runtime state, import provenance and timestamps. It does not separately hash image file contents. It selects a copy with fewer recorded missing assets and marks other exact copies using native `trashTime`; it does not reduce the total character-record count. The safety snapshot `migration-backup/pre-exact-duplicate-quarantine-1788347864427.bin` is still present.

This describes that exact-deduplication operation. It does **not** assert that every item currently in native trash came from that operation, or that later edits to a retained copy leave it identical today.

## Tests

```powershell
node --test tools/audit-exact-module-duplicates.test.cjs tools/quarantine-exact-module-duplicates.test.cjs
```

23 tests cover full-field equality, manifest validation, runtime/reference blocking, unrelated-byte preservation, read-only dry runs, stale-hash refusal, transaction rollback, archive creation, idempotent merge restoration, later-edit preservation and ignoring stale chunk manifests after a raw overwrite.
