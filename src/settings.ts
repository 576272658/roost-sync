import { App, Notice, PluginSettingTab, Setting, type SettingDefinition, type SettingDefinitionGroup, type SettingDefinitionItem } from "obsidian";
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
	/** Permanently delete files that have been in the vault's .trash this long. Off by default. */
	cleanVaultTrash: boolean;
	vaultTrashDays: number;
	concurrency: number;
	language: LanguageSetting;
	configSync: ConfigSyncOptions;
	/** Use the settings shared through the server (sharedSettings.ts). Per device. */
	shareSettings: boolean;
	/** When this device last changed a shared setting. */
	sharedUpdatedAt: number;
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
	cleanVaultTrash: false,
	vaultTrashDays: 30,
	concurrency: 4,
	language: "auto",
	configSync: DEFAULT_CONFIG_SYNC,
	shareSettings: true,
	sharedUpdatedAt: 0,
};

type Def = SettingDefinition;
type Group = SettingDefinitionGroup;

/** Optional on Obsidian before 1.13 (declarative settings API). */
interface DeclarativeTab {
	update?: () => void;
	refreshDomState?: () => void;
}

/**
 * Settings are defined once, in getSettingDefinitions(). Obsidian 1.13+ renders them
 * itself and indexes them for settings search; older versions call display(), which
 * renders the same definitions with the classic Setting API.
 */
export class RoostSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: RoostSyncPlugin) {
		super(app, plugin);
	}

	private get s() {
		return this.plugin.settings;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.s;
		const version = this.plugin.manifest.version;
		const num = (key: string, name: string, min: number, desc?: string): Def => ({
			name,
			desc,
			control: { type: "number", key, min, validate: (n: number) => (Number.isFinite(n) && n >= min ? undefined : L(`At least ${min}`, `最小为 ${min}`)) },
		});
		const toggle = (key: string, name: string, desc?: string): Def => ({ name, desc, control: { type: "toggle", key } });
		const button = (name: string, desc: string, text: string, onClick: () => unknown): Def => ({
			name,
			desc,
			render: (setting: Setting) => {
				setting.addButton((b) => b.setButtonText(text).onClick(() => void onClick()));
			},
		});
		const cfgOn = () => s.configSync.enabled;
		const cfgToggle = (key: keyof ConfigSyncOptions, name: string, desc: string): Def => ({ ...toggle(`configSync.${key}`, name, desc), visible: cfgOn });

		return [
			{
				name: `Roost Sync ${version}`,
				desc: createFragment((f) => {
					f.appendText(L("Current version. Changes in each version: ", "当前版本。各版本的更新内容："));
					f.createEl("a", { text: L("release notes", "发布说明"), href: "https://github.com/576272658/roost-sync/releases" });
				}),
				aliases: ["version", "版本"],
			},
			{
				name: L("Language", "语言"),
				desc: L("Messages and dialogs. Command names change after restarting Obsidian.", "提示和窗口的语言。命令面板里的命令名重启 Obsidian 后更新。"),
				control: { type: "dropdown", key: "language", options: { auto: L("Follow Obsidian", "跟随 Obsidian"), zh: "中文", en: "English" } },
			},
			{
				type: "group",
				heading: L("Server", "服务器"),
				items: [
					{
						name: L("WebDAV address", "WebDAV 地址"),
						desc: L("For example http://mac-mini.tailnet.ts.net:8080/", "例如 http://mac-mini.tailnet.ts.net:8080/"),
						control: { type: "text", key: "serverUrl" },
					},
					{ name: L("Username", "用户名"), control: { type: "text", key: "username" } },
					{
						name: L("Password", "密码"),
						desc: L("Stored in this plugin's data.json, which Roost Sync never uploads.", "保存在本插件的 data.json 里，Roost Sync 不会上传这个文件。"),
						render: (setting: Setting) => {
							setting.addText((t) => {
								t.inputEl.type = "password";
								t.setValue(s.password).onChange(async (v) => this.setControlValue("password", v));
							});
						},
					},
					{
						name: L("Remote folder", "远端目录"),
						desc: L("Folder on the server for this vault. Each vault needs its own folder.", "这个笔记库在服务器上的目录，每个库用不同的目录。"),
						control: { type: "text", key: "remoteFolder" },
					},
					button(
						L("Test connection", "连接测试"),
						L("Checks login, hidden folders, conditional writes, move and Unicode names.", "检查登录、隐藏目录、条件写入、移动和中文文件名。"),
						L("Run test", "开始测试"),
						() => this.plugin.testConnection(),
					),
					toggle(
						"detectServerChanges",
						L("Detect changes made directly on the server", "检测服务器目录上的直接修改"),
						L(
							"Before each sync, compare the server folder with the manifest, so edits made there by an AI agent, Finder or scripts are synced too. Costs one directory listing per sync.",
							"每次同步前把服务器目录和清单对一遍账，这样 AI Agent、Finder、脚本直接在服务器目录里做的修改也能同步。每次同步多一次目录列举。",
						),
					),
				],
			},
			{
				type: "group",
				heading: L("Config folder", "配置目录"),
				items: [
					toggle(
						"configSync.enabled",
						L("Sync the config folder", "同步配置目录"),
						L(
							`Sync parts of ${this.app.vault.configDir}/ below. Never synced: workspace layout, and Roost Sync's own folder (password, device id). Exclude one plugin by adding \`.obsidian/plugins/<id>/\` to Ignore.`,
							`同步 ${this.app.vault.configDir}/ 里下面勾选的部分。永远不同步：工作区布局、Roost Sync 自己的目录（密码、设备 ID）。想排除某个插件，在「忽略规则」里加一行 \`.obsidian/plugins/<插件ID>/\`。`,
						),
					),
					cfgToggle("plugins", L("Community plugins (code and settings)", "第三方插件（代码和设置）"), "plugins/"),
					cfgToggle("pluginList", L("Which plugins are enabled", "插件启用列表"), "community-plugins.json, core-plugins.json"),
					cfgToggle("appearance", L("Appearance, themes, CSS snippets", "外观、主题、CSS 片段"), "appearance.json, themes/, snippets/"),
					cfgToggle("hotkeys", L("Hotkeys", "快捷键"), "hotkeys.json"),
					cfgToggle("app", L("Editor settings and core plugin settings", "编辑器设置和核心插件设置"), "app.json, daily-notes.json, templates.json, bookmarks.json …"),
					cfgToggle("graph", L("Graph view settings", "关系图设置"), "graph.json"),
				],
			},
			{
				type: "group",
				heading: L("This device", "本机"),
				items: [
					toggle(
						"shareSettings",
						L("Use shared settings", "本机使用共用设置"),
						L(
							"When on, “When to sync”, “Safety”, “Filters”, “Retention”, server-change detection and the config folder switches are the same on every device: a change made on any device reaches the others at their next sync. Turn off to give this device its own values. Server address, password, device name and language are always per device.",
							"开启时，「同步时机」「安全」「过滤」「保留期」、服务器直接修改检测和配置目录各开关在所有设备上保持一致：在任意设备上修改，其他设备下次同步时自动应用。关闭则本机单独设置。服务器地址、密码、设备名、语言始终是每台设备各自的。",
						),
					),
					{
						name: L("Device name", "设备名"),
						desc: L(`Shown to other devices. Device ID: ${s.deviceId}`, `显示给其他设备看。设备 ID：${s.deviceId}`),
						control: { type: "text", key: "deviceName" },
					},
				],
			},
			{
				type: "group",
				heading: L("When to sync", "同步时机"),
				items: [
					toggle("syncOnStartup", L("Sync on startup", "启动后同步")),
					num("startupDelaySec", L("Startup delay (seconds)", "启动延迟（秒）"), 0),
					num("intervalMinutes", L("Sync every N minutes", "每 N 分钟同步"), 0, L("0 = off", "0 = 关闭")),
					num("syncAfterEditSec", L("Sync N seconds after an edit", "编辑后 N 秒同步"), 0, L("0 = off", "0 = 关闭")),
				],
			},
			{
				type: "group",
				heading: L("Safety", "安全"),
				items: [
					num(
						"thresholdPercent",
						L("Preview threshold (%)", "预览阈值（%）"),
						0,
						L("Show the plan first when deletions + new uploads + resurrections exceed this share of all files…", "删除、新建推送、复活的数量超过全部文件的这个比例时，先显示预览…"),
					),
					num("thresholdMin", L("…and this many files", "……并且超过这么多个文件"), 0),
					toggle("alwaysPreview", L("Always preview", "每次都预览")),
				],
			},
			{
				type: "group",
				heading: L("Filters", "过滤"),
				items: [
					num("maxFileSizeMB", L("Skip files larger than (MB)", "跳过大于此大小的文件（MB）"), 1),
					{
						name: L("Ignore", "忽略规则"),
						desc: L(
							"One per line. `name` or `*.ext` matches anywhere; `folder/` or `a/b.md` is relative to the vault root; `/regex/`. Paths starting with a dot are always ignored.",
							"每行一条。`name` 或 `*.ext` 匹配任意位置；`folder/`、`a/b.md` 从库根目录算起；`/正则/`。以点开头的路径始终忽略。",
						),
						control: { type: "textarea", key: "ignorePatterns", rows: 6 },
					},
				],
			},
			{
				type: "group",
				heading: L("Retention", "保留期"),
				items: [
					num("tombstoneDays", L("Deletion records (days)", "删除记录（天）"), 7),
					num("archiveDays", L("Server trash and conflict archive (days)", "服务器回收站和冲突归档（天）"), 1),
					toggle(
						"cleanVaultTrash",
						L("Empty the vault's .trash automatically", "自动清理库内 .trash"),
						L(
							"Obsidian never empties the .trash folder in the vault (the only trash on iPhone, iPad and Android). When on, files that have been there longer than the days below are deleted for good. Age is counted from when Roost Sync first saw the file there, so turning this on never deletes anything right away. The system trash is not touched.",
							"Obsidian 不会自动清空库里的 .trash 文件夹（手机和平板上删除的文件都在这里）。开启后，在里面放了超过下面天数的文件会被彻底删除。天数从 Roost Sync 第一次在 .trash 里看到这个文件时算起，所以刚开启时不会马上删掉任何东西。不影响系统回收站。",
						),
					),
					{ ...num("vaultTrashDays", L("…after this many days", "……超过这么多天"), 1), visible: () => s.cleanVaultTrash },
				],
			},
			{
				type: "group",
				heading: L("Setup and recovery", "初始化与恢复"),
				items: [
					button(
						L("Initialize server from this device", "从本机初始化服务器"),
						L("Run once, on your most complete device. Other devices then just sync.", "只需在最新、最完整的那台设备上执行一次，其他设备直接同步即可。"),
						L("Initialize", "初始化"),
						() => this.plugin.initServer(),
					),
					button(
						L("Forget local sync history", "清除本机同步记录"),
						L("This device will rejoin carefully: files only here are listed for you to confirm.", "本机会以加入模式重新接入：只在本机存在的文件会列出来让你确认。"),
						L("Reset", "重置"),
						async () => {
							await this.plugin.stateStore.clear();
							new Notice(L("Roost Sync: local sync history cleared.", "Roost Sync：已清除本机同步记录。"));
						},
					),
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		let v: unknown = this.s;
		for (const part of key.split(".")) v = (v as Record<string, unknown> | undefined)?.[part];
		return v;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.s;
		if (typeof value === "string") {
			const v = value;
			if (key === "serverUrl") value = v.trim();
			if (key === "remoteFolder") value = v.trim().replace(/^\/+|\/+$/g, "");
			if (key === "deviceName") value = v.trim() || s.deviceName;
		}
		const parts = key.split(".");
		let target = s as unknown as Record<string, unknown>;
		for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
		target[parts[parts.length - 1]] = value;

		if (key === "shareSettings") {
			// Re-enabling: adopt the shared values at the next sync.
			if (value) s.sharedUpdatedAt = 0;
			await this.plugin.saveSettings({ keepSharedTimestamp: true });
			return;
		}
		await this.plugin.saveSettings();
		if (key === "intervalMinutes") this.plugin.rescheduleTimers();
		if (key === "cleanVaultTrash" && value) void this.plugin.cleanVaultTrash(true);
		if (key === "language") {
			this.plugin.applyLanguage();
			this.rerender();
		} else if (key === "configSync.enabled" || key === "cleanVaultTrash") {
			this.refreshVisibility();
		}
	}

	/** Labels changed (language): rebuild everything. */
	private rerender() {
		const tab = this as DeclarativeTab;
		if (tab.update) tab.update();
		else this.renderClassic();
	}

	private refreshVisibility() {
		const tab = this as DeclarativeTab;
		if (tab.refreshDomState) tab.refreshDomState();
		else this.renderClassic();
	}

	/** Obsidian before 1.13 only; newer versions render getSettingDefinitions() themselves. */
	display(): void {
		this.renderClassic();
	}

	private renderClassic() {
		const { containerEl } = this;
		containerEl.empty();
		for (const item of this.getSettingDefinitions()) {
			if ("type" in item) {
				if (item.type === "page") continue;
				const group = item as Group;
				if (isHidden(group.visible)) continue;
				if (group.heading) new Setting(containerEl).setName(group.heading).setHeading();
				for (const sub of group.items ?? []) if (!("type" in sub)) this.renderClassicDef(sub);
			} else {
				this.renderClassicDef(item);
			}
		}
	}

	private renderClassicDef(def: Def) {
		if (isHidden(def.visible)) return;
		const setting = new Setting(this.containerEl).setName(def.name);
		if (def.desc) setting.setDesc(def.desc);
		if (def.render) {
			(def.render as (s: Setting) => void)(setting);
			return;
		}
		const c = def.control;
		if (!c) return;
		const value = this.getControlValue(c.key);
		const text = typeof value === "string" ? value : "";
		const set = (v: unknown) => void this.setControlValue(c.key, v);
		switch (c.type) {
			case "toggle":
				setting.addToggle((t) => t.setValue(Boolean(value)).onChange(set));
				break;
			case "dropdown":
				setting.addDropdown((d) => d.addOptions(c.options).setValue(text).onChange(set));
				break;
			case "text":
				setting.addText((t) => t.setValue(text).onChange(set));
				break;
			case "textarea":
				setting.addTextArea((t) => {
					if (c.rows) t.inputEl.rows = c.rows;
					t.setValue(text).onChange(set);
				});
				break;
			case "number":
				setting.addText((t) => {
					t.inputEl.type = "number";
					t.setValue(typeof value === "number" ? String(value) : "").onChange((v) => {
						const n = Number(v);
						if (Number.isFinite(n) && n >= (c.min ?? -Infinity)) set(n);
					});
				});
				break;
		}
	}
}

function isHidden(visible: boolean | (() => boolean) | undefined): boolean {
	return visible === false || (typeof visible === "function" && !visible());
}
