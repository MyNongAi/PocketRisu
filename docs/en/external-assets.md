<p align="center">
  <strong>English</strong> | <a href="../ko/external-assets.md">한국어</a>
</p>

# External Asset Storage

PocketRisu can keep character and module image binaries outside the Risu database. The database retains only small mappings such as the asset name, SHA-256 hash, size, and provider ID. References use this form:

```text
external://provider-id/sha256-hash
```

Chat rendering uses a lazy server URL only when an image is actually needed. Original bytes are read only for operations that require them, such as migration verification or a compatible export.

## Choosing a storage provider

Configure the provider under **External asset storage (PocketRisu core)** in Advanced Settings.

| Provider | Use | Notes |
| --- | --- | --- |
| App-local filesystem | Default. Stores files at `save/external-assets/store`, relative to the PocketRisu working directory | Simplest option and preserved by PocketRisu's normal update paths |
| Custom filesystem | Another drive, a mounted NAS, or a shared folder accessible to Termux | You are responsible for the path and folder permissions |
| HTTP | The server sends `GET` and `PUT` to `base-url/<sha256>` | Migration needs a writable endpoint. Authentication headers remain on the PocketRisu server |
| Android SAF | Not currently supported | See below |

PocketRisu on Android runs as a **Node server in Termux plus a browser**, not as a native app. There is therefore no native bridge for the SAF folder picker, persistent URI grants, or document-provider streams. For now, use a path that Termux can access as an ordinary filesystem location, such as shared storage granted through `termux-setup-storage`.

## Safe migration

Create a backup first, then use this sequence:

1. Select **Scan** to inspect character and module references, unique asset count, total size, and missing files.
2. Select **Migrate safely**. PocketRisu copies each file to the external store, downloads it again, and verifies its hash and size.
3. On success, the database references are switched to `external://...` in one publish step and the page reloads. Existing references are not changed unless every staging step succeeds.
4. Internal originals are not permanently deleted. Recoverable copies remain at the configured trash path (default `save/external-assets/trash`). When a filesystem provider and trash share a volume, hard links avoid consuming the payload bytes twice.
5. Select **Verify again** to re-download and check the external files, then manually open the affected characters and modules.
6. Only after user verification, select **Purge verified trash**. PocketRisu rejects deletion of unverified entries.

If migration fails partway through, the existing database references and internal assets remain intact. Some unreferenced copies may remain in the external store, but PocketRisu does not publish references to them.

## Rendering only recent chat outputs

The **Asset render window** setting controls how many recent character outputs on the current chat page may resolve real media URLs.

- The default is `5`.
- `0` means unlimited and renders assets for all outputs, matching legacy behavior.
- Older messages keep their text, but do not request file URLs for `{{asset}}`, `{{image}}`, `{{emotion}}`, and related media.
- When a new output moves media outside the window, its DOM nodes, Object URLs, and decoded image memory are released.

This avoids reading every historical image when opening a large chat and reduces network, memory, and decoding work.

## Backups and moving to another computer

PocketRisu's default backup contains the small external-asset manifest instead of the original external binaries. The manifest carries the `external://` mappings and verification metadata, but it does not contain provider credentials or a complete copy of the images.

To restore on another computer, prepare both parts:

1. Import the normal PocketRisu backup.
2. Copy the asset folder separately or keep using the same HTTP store, then configure the **same provider ID** to point at the new path or base URL.

The local path may differ between computers, but the provider ID referenced by the manifest must remain the same. Otherwise PocketRisu cannot locate the store.

Only an upstream-compatible RisuAI export downloads the external files at export time and embeds their original bytes. It can therefore be much larger and slower than the default PocketRisu backup.

## Failures and caching

External requests are retried according to the configured retry count. If the external provider fails, PocketRisu checks the retained trash copy and any remaining internal file in turn. If every source fails, chat rendering shows a load error.

The server byte cache is a size-bounded in-memory LRU. Older entries are evicted automatically, and the cache does not rebuild the whole external store locally. Its limit and the retry count are configurable in the same Advanced Settings section.
