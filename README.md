# Roost Sync

English | [中文](#中文说明)

Sync your Obsidian vault, settings and plugins with your own WebDAV server. Devices that were offline, or reinstalled, never bring deleted files back.

## Features

- **Deletions are recorded on the server.** A device that comes back after weeks finds that its old copies were deleted elsewhere, and moves them to the trash instead of uploading them again.
- **Notes edited on two devices are merged.** Edits to different paragraphs are combined automatically. Edits to the same lines open a window where you merge section by section. The versions that get replaced are archived on the server.
- **Risky syncs are previewed.** Mass deletions and uploads from a new device are shown to you before anything happens.
- **Renames are detected**, so renamed files and folders are not transferred again.
- **Settings and plugins sync too**, with a switch for each part of the config folder.
- **Edits made directly in the server folder are picked up**, for example by scripts or an AI agent working on the server.
- **Old copies are cleaned up.** The server's trash and conflict archive are pruned after 30 days. Emptying the vault's `.trash` automatically is optional.
- Works on desktop and mobile, in English and Chinese.

## Install

In Obsidian, open **Settings → Community plugins → Browse**, search for **Roost Sync**, then install and enable it on every device.

To try beta versions, use [BRAT](https://github.com/TfTHacker/obsidian42-brat) with `576272658/roost-sync`.

## Getting started

1. On each device, enter the WebDAV address, username, password and a remote folder.
2. Run **Test connection**.
3. Run **Sync now** on your most complete device first. It sets up the server folder.
4. Run **Sync now** on the other devices. Files that exist only on a joining device are listed for you to confirm before they are uploaded.

Back up your vault before the first sync. Tested with WsgiDAV; any WebDAV server that passes **Test connection** should work.

## Privacy

- Roost Sync connects only to the WebDAV server you configure. It has no telemetry and needs no account.
- Your password stays in this plugin's `data.json` on each device and is never uploaded or synced.
- Sync records are stored in `.sync/` on your server.

## Development

```bash
npm install
npm run build   # type-check + production build
npm test        # unit tests + integration tests against a throwaway WsgiDAV (needs `uvx`)
```

Releases are built by GitHub Actions when a version tag (e.g. `0.2.0`) is pushed.

## License

MIT

---

## 中文说明

Roost Sync 把 Obsidian 笔记库、设置和插件同步到你自己的 WebDAV 服务器。离线很久或重装过的设备，不会把已删除的文件传回来。

**主要功能**
- **删除记录保存在服务器上**：设备隔了很久再同步，会发现自己手上的旧文件已经在别处删掉了，于是把它们移进回收站，而不是重新上传。
- **两台设备改了同一篇笔记会自动合并**：改的是不同段落，直接合成一份；改了同一处，弹窗让你逐段选择。被替换的版本归档在服务器上。
- **大量删除、新设备首次上传等有风险的同步**，执行前先给你看计划。
- **识别重命名和移动**，不会重新传输文件。
- **同步设置和插件**，配置目录的每一部分都可以单独开关。
- **能识别直接在服务器目录里做的修改**，比如脚本或 AI Agent 改的文件。
- 服务器上的回收站和冲突归档 30 天后自动清理；也可以选择自动清理库里的 `.trash`。
- 支持电脑和手机，中英文界面。

**安装**：Obsidian「设置 → 第三方插件 → 浏览」，搜索 **Roost Sync**，在每台设备上安装并启用。

**开始使用**
1. 在每台设备上填写 WebDAV 地址、用户名、密码和远端目录。
2. 点「连接测试」。
3. 先在文件最全的那台设备上点「立即同步」，它会在服务器上建立同步记录。
4. 其他设备直接点「立即同步」。只在新加入的设备上才有的文件，会先列出来让你确认，确认后才上传。

第一次同步前，请先备份笔记库。

**隐私**：只连接你自己设置的 WebDAV 服务器，没有统计上报，不需要注册账号。密码只保存在本机，不会上传或同步。
