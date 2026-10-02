# Roost Sync

Sync your Obsidian vault, settings and plugins to your own WebDAV server, without stale devices resurrecting deleted files.

> Status: early (0.x). Back up your vault before trying it. Tested against WsgiDAV 4.3.3; other WebDAV servers should work if **Test connection** passes.

## Why

Most WebDAV sync plugins keep their "last synced" state only on each device. When a device has been offline for a while, or has lost that state, it cannot tell "deleted elsewhere" from "created here" and pushes deleted files back.

Roost Sync keeps the authoritative state on the server:

- **Tombstones on the server.** `.sync/manifest.json` lists every file with a SHA-256 hash, plus a tombstone for each deletion. A device that comes back after weeks, or after a reinstall, finds that its old copy matches a tombstone, so it moves that copy to the trash instead of uploading it.
- **Content hashes decide what changed, not mtimes.** A file that was only touched is not treated as edited.
- **New or reset devices join carefully.** Files that exist only on such a device are listed for you to confirm before anything is uploaded.
- **Risky syncs are previewed first.** Deletions, new uploads and resurrections count toward a threshold. When a sync goes over it, you see the plan before anything happens.
- **Nothing is deleted outright.** Deleted local files go to the system trash, or to the vault's `.trash/` on mobile. Files deleted on the server go to `.sync/trash/`.
- **Conflicts never add duplicate files to your vault.** For notes, you choose which version to keep, and the other is archived in `.sync/conflicts/`. For settings files, the newer version wins automatically and the other is archived the same way.
- **Renames are detected.** A note or folder renamed on one device is moved on the server and on the other devices. Nothing is transferred again, and the rename does not count toward the preview threshold.
- **Settings and plugins sync too.** Community plugins (code and settings), the enabled-plugins list, themes, CSS snippets, hotkeys, editor settings and core plugin settings each have their own switch. The workspace layout and Roost Sync's own folder are never synced.
- **Edits made directly in the server folder are picked up**, for example by an AI agent working on the server:
  - Before each sync, the server folder is compared with the manifest.
  - New, changed, deleted and renamed files are all detected. Renames are recognized by ETag, so the files are not downloaded again.
  - Uploads are sent with `If-Match`. If the agent wrote to the same file in the meantime, the upload is refused and the file becomes a conflict instead of being overwritten.
- **Only one device syncs at a time.** A lock file, `.sync/lock.json`, is created with a conditional PUT that only succeeds if the file does not exist yet, then read back to confirm this device owns it.
- **File names are checked across platforms** for characters Windows does not allow, names that differ only in letter case, and Unicode normalization (NFC).
- **Messages are in English or Chinese**, following Obsidian's language or a setting.

## Install

### With BRAT (recommended, works on iPhone/iPad/Android too)
1. Install **BRAT** from Community plugins and enable it.
2. Open this link on the device: `obsidian://brat?plugin=576272658/roost-sync`.
   Or, in BRAT's settings, choose **Add beta plugin** and enter `576272658/roost-sync`.
3. Enable **Roost Sync** in Community plugins.

BRAT keeps the plugin updated. Once settings sync is on, BRAT's plugin list syncs to your other devices too, so their BRAT keeps Roost Sync updated as well.

### Manually
Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/576272658/roost-sync/releases/latest). Put them in `<vault>/.obsidian/plugins/roost-sync/`.

Do **not** copy `data.json` between devices. It holds that device's ID and password.

## Usage

1. On every device, enter the WebDAV address, username, password and a remote folder.
2. Run **Test connection** to check that the server supports everything Roost Sync needs.
3. Run **Sync now**. The first device to sync with an empty server folder is asked to set it up: its files become the reference, and you decide what happens to files that exist only on the server. This happens once per server folder. Pick your most complete device for it.
4. On the other devices, just run **Sync now**.

Commands: Sync now, Show sync plan (dry run), Resolve conflicts, Test connection, Initialize server from this device, Show sync log.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check + production build
npm test        # unit tests + integration tests against a throwaway WsgiDAV (needs `uvx`)
```

To release, run `npm version 0.x.y --no-git-tag-version`, commit, tag `0.x.y` (no `v`) and push the tag. A GitHub Action builds, tests and publishes the release assets.

## License

MIT
