# Roost Sync

Sync your Obsidian vault to your own WebDAV server, without stale devices resurrecting deleted files.

> Status: early development (M1). Back up your vault before trying it.

## Why

Most WebDAV sync plugins keep their "last synced" state only on each device. When a device has been offline for a while, or has lost that state, it cannot tell "deleted elsewhere" from "created here" and pushes deleted files back.

Roost Sync keeps the authoritative state on the server:

- `.sync/manifest.json` lists every file with a SHA-256 hash, plus **tombstones** for deletions. A device that comes back after weeks, or after a reinstall, sees that its old copy matches a tombstone and removes it locally (to the trash) instead of uploading it.
- **Content hashes, not mtimes**, decide what changed, so a file that was only "touched" is not treated as edited.
- **New or reset devices join carefully.** Files that exist only on such a device are listed for confirmation instead of being uploaded silently.
- **Preview before risky syncs.** Deletions, new uploads and resurrections count toward a threshold; above it, you see the plan first.
- **Nothing is deleted outright.** Local deletions go to the system trash (or the vault's `.trash/` on mobile). Server deletions go to `.sync/trash/`.
- **Conflicts never create duplicate files in your vault.** You choose which version to keep; the other is archived in `.sync/conflicts/`.
- **A sync lock** (`.sync/lock.json`, written with a create-only conditional PUT and verified by reading it back) keeps two devices from syncing at once.
- **Edits made directly in the server folder are picked up.** For example, an AI agent working on the server. Before each sync, the server folder is compared with the manifest. New, changed and deleted files are recorded, and deletions get tombstones like any other. Uploads use `If-Match`, so an agent's concurrent write is never overwritten. It becomes a conflict instead.
- **Cross-platform name checks** cover Windows-illegal names, case-only collisions and Unicode normalization (NFC).

## Usage

1. Install the plugin on every device and enter the WebDAV address, username, password and a remote folder.
2. Run **Test connection** to check that the server supports what Roost Sync needs.
3. On your most complete device, run **Initialize server from this device**.
4. On the other devices, run **Sync now**.

Commands: Sync now, Show sync plan (dry run), Resolve conflicts, Test connection, Initialize server from this device, Show sync log.

Currently syncs vault files only. `.obsidian` config and plugin sync is planned for the next milestone.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check + production build
npm test        # unit tests; integration tests also start a throwaway WsgiDAV via `uvx` when available
```

## License

MIT
