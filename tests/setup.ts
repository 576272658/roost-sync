// The plugin uses window.setTimeout & co. (Obsidian popout-window compatibility); Node has no window.
(globalThis as { window?: unknown }).window ??= globalThis;
