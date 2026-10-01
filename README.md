# Roost Sync

An Obsidian plugin that syncs your vault — notes, attachments, plugins and settings — to **your own WebDAV server**.

> Status: early development (M0). Not ready for use.

## Why

Most sync plugins keep "what was deleted" only in each device's local database. When a device's local state is lost, or it hasn't synced for a while, deleted files can come back from the dead.

Roost Sync keeps a manifest with **deletion tombstones on the server**, and detects changes by **content hash** instead of modification time, so a stale device cannot resurrect files deleted elsewhere.

## Planned features

- WebDAV only (tested with WsgiDAV), works on desktop and mobile
- Server-side manifest + tombstones, content hashing
- Sync lock to prevent concurrent syncs
- Preview & confirm before bulk deletions / resurrections
- Three-way merge for Markdown; you choose when edits overlap — no duplicate `conflict` files
- Sync `.obsidian` plugins, themes, snippets and settings (workspace layout excluded)
- Deleted files go to trash (system trash on desktop, `.trash/` on mobile, `.sync/trash/` on server)

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # production build
npm test
```

## License

[MIT](./LICENSE)
