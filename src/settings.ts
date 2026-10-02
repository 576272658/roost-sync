import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { L } from "./i18n";
import type RoostSyncPlugin from "./main";
import { DEFAULT_IGNORES } from "./util/paths";
import { DEFAULT_CONFIG_SYNC, type ConfigSyncOptions } from "./sync/config";
import type { LanguageSetting } from "./i18n";

export interface RoostSettings {
	serverUrl: string;
	username: string;
	password: string;
	remoteFolder: string;
	deviceId: string;
	deviceName: string;
	syncOnStartup: boolean;
	startupDelaySec: number;
	intervalMinutes: number;
	syncAfterEditSec: number;
	thresholdPercent: number;
	thresholdMin: number;
	alwaysPreview: boolean;
	detectServerChanges: boolean;
	maxFileSizeMB: number;
	ignorePatterns: string;
	tombstoneDays: number;
	archiveDays: number;
	concurrency: number;
	language: LanguageSetting;
	configSync: ConfigSyncOptions;
}

export const DEFAULT_SETTINGS: Omit<RoostSettings, "deviceId" | "deviceName" | "remoteFolder"> = {
	serverUrl: "",
	username: "",
	password: "",
	syncOnStartup: true,
	startupDelaySec: 5,
	intervalMinutes: 0,
	syncAfterEditSec: 0,
	thresholdPercent: 5,
	thresholdMin: 10,
	alwaysPreview: false,
	detectServerChanges: true,
	maxFileSizeMB: 20,
	ignorePatterns: DEFAULT_IGNORES.join("\n"),
	tombstoneDays: 90,
	archiveDays: 30,
	concurrency: 4,
	language: "auto",
	configSync: DEFAULT_CONFIG_SYNC,
};

export class RoostSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: RoostSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		const num = (setting: Setting, get: () => number, set: (n: number) => void, min = 0) =>
			setting.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(get())).onChange(async (v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= min) {
						set(n);
						await save();
					}
				});
			});

		new Setting(containerEl)
			.setName(L("Language", "语言"))
			.setDesc(L("Messages and dialogs. Command names change after restarting Obsidian.", "提示和窗口的语言。命令面板里的命令名重启 Obsidian 后更新。"))
			.addDropdown((d) =>
				d
					.addOption("auto", L("Follow Obsidian", "跟随 Obsidian"))
					.addOption("zh", "中文")
					.addOption("en", "English")
					.setValue(s.language)
					.onChange(async (v) => {
						s.language = v as LanguageSetting;
						await save();
						this.plugin.applyLanguage();
						this.display();
					}),
			);

		new Setting(containerEl).setName(L("Server", "服务器")).setHeading();
		new Setting(containerEl)
			.setName(L("WebDAV address", "WebDAV 地址"))
			.setDesc(L("For example http://mac-mini.tailnet.ts.net:8080/", "例如 http://mac-mini.tailnet.ts.net:8080/"))
			.addText((t) => t.setPlaceholder("http://…").setValue(s.serverUrl).onChange(async (v) => ((s.serverUrl = v.trim()), await save())));
		new Setting(containerEl)
			.setName(L("Username", "用户名"))
			.addText((t) => t.setValue(s.username).onChange(async (v) => ((s.username = v), await save())));
		new Setting(containerEl)
			.setName(L("Password", "密码"))
			.setDesc(L("Stored in this plugin's data.json, which Roost Sync never uploads.", "保存在本插件的 data.json 里，Roost Sync 不会上传这个文件。"))
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.password).onChange(async (v) => ((s.password = v), await save()));
			});
		new Setting(containerEl)
			.setName(L("Remote folder", "远端目录"))
			.setDesc(L("Folder on the server for this vault. Each vault needs its own folder.", "这个笔记库在服务器上的目录，每个库用不同的目录。"))
			.addText((t) => t.setValue(s.remoteFolder).onChange(async (v) => ((s.remoteFolder = v.trim().replace(/^\/+|\/+$/g, "")), await save())));
		new Setting(containerEl)
			.setName(L("Test connection", "连接测试"))
			.setDesc(L("Checks login, hidden folders, conditional writes, move and Unicode names.", "检查登录、隐藏目录、条件写入、移动和中文文件名。"))
			.addButton((b) => b.setButtonText(L("Run test", "开始测试")).onClick(() => this.plugin.testConnection()));

		new Setting(containerEl)
			.setName(L("Detect changes made directly on the server", "检测服务器目录上的直接修改"))
			.setDesc(
				L(
					"Before each sync, compare the server folder with the manifest, so edits made there by an AI agent, Finder or scripts are synced too. Costs one directory listing per sync.",
					"每次同步前把服务器目录和清单对一遍账，这样 AI Agent、Finder、脚本直接在服务器目录里做的修改也能同步。每次同步多一次目录列举。",
				),
			)
			.addToggle((t) => t.setValue(s.detectServerChanges).onChange(async (v) => ((s.detectServerChanges = v), await save())));

		new Setting(containerEl).setName(L("Obsidian settings and plugins", "Obsidian 设置和插件")).setHeading();
		const cfg = s.configSync;
		const cfgToggle = (name: string, desc: string, key: keyof ConfigSyncOptions) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(cfg[key]).onChange(async (v) => {
						cfg[key] = v;
						await save();
						if (key === "enabled") this.display();
					}),
				);
		cfgToggle(
			L("Sync the config folder", "同步配置目录"),
			L(
				`Sync parts of ${this.app.vault.configDir}/ below. Never synced: workspace layout, and Roost Sync's own folder (password, device id). Exclude one plugin by adding \`.obsidian/plugins/<id>/\` to Ignore.`,
				`同步 ${this.app.vault.configDir}/ 里下面勾选的部分。永远不同步：工作区布局、Roost Sync 自己的目录（密码、设备 ID）。想排除某个插件，在「忽略规则」里加一行 \`.obsidian/plugins/<插件ID>/\`。`,
			),
			"enabled",
		);
		if (cfg.enabled) {
			cfgToggle(L("Community plugins (code and settings)", "第三方插件（代码和设置）"), "plugins/", "plugins");
			cfgToggle(L("Which plugins are enabled", "插件启用列表"), "community-plugins.json, core-plugins.json", "pluginList");
			cfgToggle(L("Appearance, themes, CSS snippets", "外观、主题、CSS 片段"), "appearance.json, themes/, snippets/", "appearance");
			cfgToggle(L("Hotkeys", "快捷键"), "hotkeys.json", "hotkeys");
			cfgToggle(
				L("Editor settings and core plugin settings", "编辑器设置和核心插件设置"),
				"app.json, daily-notes.json, templates.json, bookmarks.json …",
				"app",
			);
			cfgToggle(L("Graph view settings", "关系图设置"), "graph.json", "graph");
		}

		new Setting(containerEl).setName(L("This device", "本机")).setHeading();
		new Setting(containerEl)
			.setName(L("Device name", "设备名"))
			.setDesc(L(`Shown to other devices. Device ID: ${s.deviceId}`, `显示给其他设备看。设备 ID：${s.deviceId}`))
			.addText((t) => t.setValue(s.deviceName).onChange(async (v) => ((s.deviceName = v.trim() || s.deviceName), await save())));

		new Setting(containerEl).setName(L("When to sync", "同步时机")).setHeading();
		new Setting(containerEl)
			.setName(L("Sync on startup", "启动后同步"))
			.addToggle((t) => t.setValue(s.syncOnStartup).onChange(async (v) => ((s.syncOnStartup = v), await save())));
		num(new Setting(containerEl).setName(L("Startup delay (seconds)", "启动延迟（秒）")), () => s.startupDelaySec, (n) => (s.startupDelaySec = n));
		num(
			new Setting(containerEl).setName(L("Sync every N minutes", "每 N 分钟同步")).setDesc(L("0 = off", "0 = 关闭")),
			() => s.intervalMinutes,
			(n) => {
				s.intervalMinutes = n;
				this.plugin.rescheduleTimers();
			},
		);
		num(
			new Setting(containerEl).setName(L("Sync N seconds after an edit", "编辑后 N 秒同步")).setDesc(L("0 = off", "0 = 关闭")),
			() => s.syncAfterEditSec,
			(n) => (s.syncAfterEditSec = n),
		);

		new Setting(containerEl).setName(L("Safety", "安全")).setHeading();
		num(
			new Setting(containerEl)
				.setName(L("Preview threshold (%)", "预览阈值（%）"))
				.setDesc(L("Show the plan first when deletions + new uploads + resurrections exceed this share of all files…", "删除、新建推送、复活的数量超过全部文件的这个比例时，先显示预览…")),
			() => s.thresholdPercent,
			(n) => (s.thresholdPercent = n),
		);
		num(
			new Setting(containerEl).setName(L("…and this many files", "……并且超过这么多个文件")),
			() => s.thresholdMin,
			(n) => (s.thresholdMin = n),
		);
		new Setting(containerEl)
			.setName(L("Always preview", "每次都预览"))
			.addToggle((t) => t.setValue(s.alwaysPreview).onChange(async (v) => ((s.alwaysPreview = v), await save())));

		new Setting(containerEl).setName(L("Filters", "过滤")).setHeading();
		num(new Setting(containerEl).setName(L("Skip files larger than (MB)", "跳过大于此大小的文件（MB）")), () => s.maxFileSizeMB, (n) => (s.maxFileSizeMB = n), 1);
		new Setting(containerEl)
			.setName(L("Ignore", "忽略规则"))
			.setDesc(
				L(
					"One per line. `name` or `*.ext` matches anywhere; `folder/` or `a/b.md` is relative to the vault root; `/regex/`. Paths starting with a dot are always ignored.",
					"每行一条。`name` 或 `*.ext` 匹配任意位置；`folder/`、`a/b.md` 从库根目录算起；`/正则/`。以点开头的路径始终忽略。",
				),
			)
			.addTextArea((t) => {
				t.inputEl.rows = 6;
				t.setValue(s.ignorePatterns).onChange(async (v) => ((s.ignorePatterns = v), await save()));
			});

		new Setting(containerEl).setName(L("Retention", "保留期")).setHeading();
		num(new Setting(containerEl).setName(L("Deletion records (days)", "删除记录（天）")), () => s.tombstoneDays, (n) => (s.tombstoneDays = n), 7);
		num(new Setting(containerEl).setName(L("Server trash and conflict archive (days)", "服务器回收站和冲突归档（天）")), () => s.archiveDays, (n) => (s.archiveDays = n), 1);

		new Setting(containerEl).setName(L("Setup and recovery", "初始化与恢复")).setHeading();
		new Setting(containerEl)
			.setName(L("Initialize server from this device", "从本机初始化服务器"))
			.setDesc(L("Run once, on your most complete device. Other devices then just sync.", "只需在最新、最完整的那台设备上执行一次，其他设备直接同步即可。"))
			.addButton((b) => b.setButtonText(L("Initialize", "初始化")).onClick(() => this.plugin.initServer()));
		new Setting(containerEl)
			.setName(L("Forget local sync history", "清除本机同步记录"))
			.setDesc(L("This device will rejoin carefully: files only here are listed for you to confirm.", "本机会以加入模式重新接入：只在本机存在的文件会列出来让你确认。"))
			.addButton((b) =>
				b.setButtonText(L("Reset", "重置")).onClick(async () => {
					await this.plugin.stateStore.clear();
					new Notice(L("Roost Sync: local sync history cleared.", "Roost Sync：已清除本机同步记录。"));
				}),
			);
	}
}
