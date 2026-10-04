import { Notice, Platform, Plugin, TAbstractFile, getLanguage, normalizePath } from "obsidian";
import { L, setLanguage } from "./i18n";
import { DEFAULT_CONFIG_SYNC, configDirMayContain, configFileAllowed, needsRestart } from "./sync/config";
import { pickShared, syncSharedSettings } from "./sync/sharedSettings";
import { FileStateStore, VaultFs, obsidianTransport, platformName } from "./obsidian/adapters";
import { DEFAULT_SETTINGS, RoostSettingTab, type RoostSettings } from "./settings";
import { AlreadyInitializedError, NotInitializedError, SyncEngine, type SyncResult, type SyncUI } from "./sync/engine";
import { LockBusyError, RemoteRepo } from "./sync/remote";
import type { ConflictInfo } from "./sync/types";
import { ConflictModal, InitModal, LogModal, PlanModal, ProbeModal } from "./ui/modals";
import { randomId } from "./util/hash";
import { IgnoreRules } from "./util/paths";
import { cleanVaultTrash } from "./util/trashCleanup";
import { WebDavClient } from "./webdav/client";
import { probeServer } from "./webdav/probe";

type Trigger = "manual" | "startup" | "interval" | "edit" | "conflict";

export default class RoostSyncPlugin extends Plugin {
	settings!: RoostSettings;
	stateStore!: FileStateStore;
	private statusEl!: HTMLElement;
	private running = false;
	private intervalId: number | null = null;
	private lastShownConflicts = "";
	private conflicts: ConflictInfo[] = [];
	private editTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.applyLanguage();
		this.stateStore = new FileStateStore(this.app, normalizePath(`${this.manifest.dir}/state`));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("mod-clickable");
		this.statusEl.onClickEvent(() => (this.conflicts.length ? this.openConflicts() : this.sync("manual")));
		this.setStatus(L("Roost: idle", "Roost：待同步"));

		this.addRibbonIcon("refresh-cw", L("Roost Sync: sync now", "Roost Sync：立即同步"), () => this.sync("manual"));
		this.addCommand({ id: "sync-now", name: L("Sync now", "立即同步"), callback: () => this.sync("manual") });
		this.addCommand({ id: "dry-run", name: L("Show sync plan (dry run)", "预览同步计划（不执行）"), callback: () => this.sync("manual", true) });
		this.addCommand({ id: "conflicts", name: L("Resolve conflicts", "处理冲突"), callback: () => this.openConflicts() });
		this.addCommand({ id: "test-connection", name: L("Test connection", "连接测试"), callback: () => this.testConnection() });
		this.addCommand({ id: "init-server", name: L("Initialize server from this device", "从本机初始化服务器"), callback: () => this.initServer() });
		this.addCommand({ id: "show-log", name: L("Show sync log", "查看同步日志"), callback: async () => new LogModal(this.app, await this.stateStore.readLog()).open() });

		this.addSettingTab(new RoostSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			const engine = this.configured() ? this.buildEngine() : null;
			if (engine) this.setConflicts(await engine.loadConflicts().catch(() => []), false);
			if (this.settings.syncOnStartup && this.configured()) {
				window.setTimeout(() => void this.sync("startup"), this.settings.startupDelaySec * 1000);
			}
			const onEdit = (f: TAbstractFile) => this.onVaultEdit(f);
			this.registerEvent(this.app.vault.on("modify", onEdit));
			this.registerEvent(this.app.vault.on("create", onEdit));
			this.registerEvent(this.app.vault.on("delete", onEdit));
			this.registerEvent(this.app.vault.on("rename", onEdit));
		});
		this.rescheduleTimers();
	}

	onunload() {
		if (this.editTimer) window.clearTimeout(this.editTimer);
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? {}) as Partial<RoostSettings>;
		this.settings = {
			...DEFAULT_SETTINGS,
			remoteFolder: this.app.vault.getName(),
			deviceId: randomId(),
			deviceName: platformName(),
			...data,
			configSync: { ...DEFAULT_CONFIG_SYNC, ...(data.configSync ?? {}) },
		};
		this.sharedSnapshot = JSON.stringify(pickShared(this.settings));
		if (data.deviceId && data.sharedUpdatedAt === undefined) {
			// Upgrading from 0.1.1, which did not record when settings changed: if this device's
			// shared settings were customized, date them by data.json so they beat untouched devices.
			const defaults = JSON.stringify(pickShared({ ...DEFAULT_SETTINGS, configSync: DEFAULT_CONFIG_SYNC }));
			if (this.sharedSnapshot !== defaults) {
				const st = await this.app.vault.adapter.stat(normalizePath(`${this.manifest.dir}/data.json`)).catch(() => null);
				this.settings.sharedUpdatedAt = st?.mtime ?? 1;
			}
			await this.saveData(this.settings);
		}
		if (!data.deviceId) await this.saveSettings();
	}

	private sharedSnapshot = "";

	/** "auto" follows Obsidian's display language. Commands get renamed after a restart. */
	applyLanguage() {
		const pref = this.settings.language;
		if (pref === "en" || pref === "zh") return setLanguage(pref);
		const lang = getLanguage().toLowerCase();
		setLanguage(lang.startsWith("zh") ? "zh" : "en");
	}

	/** Records when a shared setting changed, so the change wins over older values on other devices. */
	async saveSettings(opts: { keepSharedTimestamp?: boolean } = {}) {
		const snap = JSON.stringify(pickShared(this.settings));
		if (snap !== this.sharedSnapshot) {
			if (!opts.keepSharedTimestamp) this.settings.sharedUpdatedAt = Date.now();
			this.sharedSnapshot = snap;
		}
		await this.saveData(this.settings);
	}

	/** Exchanges Roost Sync's shared settings with the server before each sync. */
	private async exchangeSharedSettings(quiet: boolean) {
		const s = this.settings;
		if (!s.shareSettings) return;
		try {
			const remote = new RemoteRepo(this.dav(), { id: s.deviceId, name: s.deviceName });
			const r = await syncSharedSettings(remote, s, s.sharedUpdatedAt, s.deviceName);
			if (r.action === "pushed") {
				s.sharedUpdatedAt = r.updatedAt;
				await this.saveData(s);
			} else if (r.action === "pulled") {
				Object.assign(s, structuredClone(r.settings));
				s.configSync = { ...DEFAULT_CONFIG_SYNC, ...(s.configSync ?? {}) };
				s.sharedUpdatedAt = r.updatedAt;
				this.sharedSnapshot = JSON.stringify(pickShared(s));
				await this.saveData(s);
				this.rescheduleTimers();
				if (!quiet) new Notice(L(`Roost Sync: applied sync settings changed on ${r.by}.`, `Roost Sync：已应用在「${r.by}」上修改的同步设置。`));
			}
		} catch {
			// Not fatal: the server may not be set up yet; the next sync retries.
		}
	}

	rescheduleTimers() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		const m = this.settings?.intervalMinutes ?? 0;
		if (m > 0) {
			this.intervalId = window.setInterval(() => void this.sync("interval"), m * 60_000);
			this.registerInterval(this.intervalId);
		}
	}

	private onVaultEdit(_f: TAbstractFile) {
		const sec = this.settings.syncAfterEditSec;
		if (!sec || this.running || !this.configured()) return;
		if (this.editTimer) window.clearTimeout(this.editTimer);
		this.editTimer = window.setTimeout(() => void this.sync("edit"), sec * 1000);
	}

	private configured(): boolean {
		return !!this.settings.serverUrl;
	}

	private setStatus(text: string) {
		this.statusEl?.setText(text);
	}

	private dav() {
		const s = this.settings;
		return new WebDavClient(obsidianTransport, s.serverUrl, s.remoteFolder, s.username, s.password);
	}

	private buildEngine(ui?: Partial<SyncUI>): SyncEngine {
		const s = this.settings;
		const remote = new RemoteRepo(this.dav(), { id: s.deviceId, name: s.deviceName });
		const fullUi: SyncUI = {
			reviewPlan: (review) => new Promise((resolve) => new PlanModal(this.app, review, resolve).open()),
			reviewInit: (review) => new Promise((resolve) => new InitModal(this.app, review, resolve).open()),
			progress: (msg) => this.setStatus(`Roost: ${msg}`),
			...ui,
		};
		const cfg = s.configSync;
		const fs = new VaultFs(this.app, cfg.enabled ? { file: (p) => configFileAllowed(p, cfg), dir: (p) => configDirMayContain(p, cfg) } : null);
		return new SyncEngine(fs, this.stateStore, remote, fullUi, {
			device: { id: s.deviceId, name: s.deviceName, platform: platformName() },
			pluginVersion: this.manifest.version,
			// This plugin's own folder (password, device id, state) is excluded in config.ts.
			ignore: new IgnoreRules(s.ignorePatterns.split("\n"), cfg),
			maxFileSize: s.maxFileSizeMB * 1024 * 1024,
			thresholdPercent: s.thresholdPercent,
			thresholdMin: s.thresholdMin,
			tombstoneDays: s.tombstoneDays,
			archiveDays: s.archiveDays,
			isWindows: Platform.isWin,
			concurrency: s.concurrency,
			alwaysPreview: s.alwaysPreview,
			detectServerChanges: s.detectServerChanges,
		});
	}

	async sync(trigger: Trigger, dryRun = false): Promise<void> {
		if (!this.configured()) {
			new Notice(L("Roost Sync: set the WebDAV address in settings first.", "Roost Sync：请先在设置里填写 WebDAV 地址。"));
			return;
		}
		if (this.running) {
			if (trigger === "manual") new Notice(L("Roost Sync: already syncing.", "Roost Sync：正在同步中。"));
			return;
		}
		this.running = true;
		const quiet = trigger === "interval" || trigger === "edit";
		let result: SyncResult | null = null;
		let failure: string | null = null;
		let busy = false;
		let needsSetup = false;
		if (!dryRun) await this.exchangeSharedSettings(quiet);
		try {
			result = await this.buildEngine().sync({ dryRun });
		} catch (e) {
			if (e instanceof LockBusyError) {
				busy = true;
				failure = L(`Another device is syncing (${e.holder}). Will retry shortly.`, `其他设备正在同步（${e.holder}），稍后自动重试。`);
				if (trigger !== "conflict") window.setTimeout(() => void this.sync(trigger === "manual" ? "manual" : "interval"), 20_000);
			} else if (e instanceof NotInitializedError) {
				// First device on an empty server: set it up right away (asks about server-only files).
				needsSetup = true;
				failure = L(
					"This server folder is not set up yet. Click “Sync now” to set it up from this device.",
					"这个服务器目录还没有建立同步记录。点「立即同步」即可以本机为基准建立。",
				);
			} else {
				failure = e instanceof Error ? e.message : String(e);
				console.error("Roost Sync", e);
			}
		} finally {
			this.running = false;
		}

		if (needsSetup && trigger === "manual" && !dryRun) return this.initServer();
		const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		if (failure) {
			this.setStatus(L(`Roost: failed ${now}`, `Roost：同步失败 ${now}`));
			if (!quiet || !busy) new Notice(`Roost Sync: ${failure}`, 10_000);
			await this.log(trigger, "failed", null, [failure]);
			return;
		}
		if (!result) return;
		await this.log(trigger, result.status, result);
		if (result.status === "dry-run") return this.setStatus(L("Roost: dry run done", "Roost：预览完成"));
		if (result.status === "cancelled") {
			this.setStatus(L("Roost: cancelled", "Roost：已取消"));
			return;
		}

		const s = result.summary;
		const changed = s.push + s.pull + s.deleteLocal + s.deleteRemote + s.move;
		if (changed > 0 && !quiet) {
			const parts = [
				s.push && `↑${s.push}`,
				s.pull && `↓${s.pull}`,
				s.move && L(`moved ${s.move}`, `移动 ${s.move}`),
				s.deleteLocal + s.deleteRemote && L(`deleted ${s.deleteLocal + s.deleteRemote}`, `删除 ${s.deleteLocal + s.deleteRemote}`),
			].filter(Boolean);
			new Notice(`Roost Sync: ${parts.join("  ")}`);
		}
		const auto = result.actions.filter((a) => a.autoResolved);
		if (auto.length) {
			new Notice(
				L(
					`Roost Sync: ${auto.length} settings file(s) were changed on two devices; kept the newer one (the other is in the server's .sync/conflicts/):\n`,
					`Roost Sync：${auto.length} 个配置文件在两台设备上都改过，已保留较新的（另一份在服务器 .sync/conflicts/）：\n`,
				) + auto.slice(0, 5).map((a) => a.path).join("\n"),
				12_000,
			);
		}
		const localConfigChanged = result.actions.some(
			(a) => (a.kind === "pull" || a.kind === "deleteLocal" || a.kind === "moveLocal") && needsRestart(a.path),
		);
		if (localConfigChanged) this.offerReload();
		if (result.errors.length) {
			new Notice(
				L(`Roost Sync: ${result.errors.length} file(s) skipped or failed:\n`, `Roost Sync：${result.errors.length} 个文件跳过或失败：\n`) +
					result.errors.slice(0, 5).join("\n") +
					(result.errors.length > 5 ? "\n…" : "") +
					L("\n(See “Show sync log”.)", "\n（详见「查看同步日志」）"),
				15_000,
			);
		}
		this.setConflicts(result.conflicts, true, trigger === "manual" || trigger === "conflict");
		if (!this.conflicts.length) this.setStatus(L(`Roost: synced ${now}`, `Roost：已同步 ${now}`));
		await this.cleanVaultTrash(false);
	}

	private lastTrashCleanup = 0;

	/** Optional: empties old files from the vault's .trash, at most every 6 hours unless forced. */
	async cleanVaultTrash(force: boolean): Promise<void> {
		if (!this.settings.cleanVaultTrash) return;
		if (!force && Date.now() - this.lastTrashCleanup < 6 * 3_600_000) return;
		this.lastTrashCleanup = Date.now();
		try {
			const stateDir = normalizePath(`${this.manifest.dir}/state`);
			if (!(await this.app.vault.adapter.exists(stateDir))) await this.app.vault.adapter.mkdir(stateDir);
			const seenPath = `${stateDir}/trash-seen.json`;
			const n = await cleanVaultTrash(this.app.vault.adapter, seenPath, this.settings.vaultTrashDays);
			if (n > 0) {
				new Notice(
					L(
						`Roost Sync: permanently deleted ${n} file(s) that had been in .trash for over ${this.settings.vaultTrashDays} days.`,
						`Roost Sync：已彻底删除 .trash 中超过 ${this.settings.vaultTrashDays} 天的 ${n} 个文件。`,
					),
				);
			}
		} catch (e) {
			console.error("Roost Sync: .trash cleanup failed", e);
		}
	}

	/** Plugins, themes and app settings pulled from other devices load after a restart (§4.3). */
	private offerReload() {
		const frag = createFragment((f) => {
			f.appendText(L("Roost Sync: plugins or settings were updated from another device. Reload Obsidian to apply them. ", "Roost Sync：已从其他设备同步了插件或设置，重新加载 Obsidian 后生效。"));
			// "Reload app without saving" is a built-in command; skip the button if it is unavailable.
			const commands = (this.app as unknown as { commands?: { executeCommandById?: (id: string) => boolean } }).commands;
			if (typeof commands?.executeCommandById === "function") {
				const btn = f.createEl("button", { text: L("Reload now", "立即重新加载") });
				btn.onclick = () => commands.executeCommandById!("app:reload");
			}
		});
		new Notice(frag, 0);
	}

	private setConflicts(list: ConflictInfo[], maybeOpen: boolean, force = false) {
		this.conflicts = list;
		if (!list.length) return;
		this.setStatus(L(`Roost: ${list.length} conflict(s)`, `Roost：${list.length} 个冲突待处理`));
		const key = list.map((c) => `${c.path}:${c.localHash}:${c.remoteHash}`).sort().join("|");
		if (maybeOpen && (force || key !== this.lastShownConflicts)) {
			this.lastShownConflicts = key;
			void this.openConflicts();
		}
	}

	async openConflicts() {
		if (!this.configured()) return;
		const engine = this.buildEngine();
		const list = await engine.loadConflicts();
		if (!list.length) {
			new Notice(L("Roost Sync: no conflicts.", "Roost Sync：没有冲突。"));
			return;
		}
		new ConflictModal(
			this.app,
			list,
			async (c) => ({
				local: await engine.readLocal(c.path).catch(() => null),
				remote: await engine.readRemote(c.path).catch(() => null),
			}),
			async (res) => {
				await engine.saveResolutions(res);
				await this.sync("conflict");
			},
		).open();
	}

	async testConnection() {
		if (!this.configured()) {
			new Notice(L("Roost Sync: set the WebDAV address first.", "Roost Sync：请先填写 WebDAV 地址。"));
			return;
		}
		new ProbeModal(this.app, () => probeServer(this.dav(), L)).open();
	}

	async initServer() {
		if (!this.configured()) {
			new Notice(L("Roost Sync: set the WebDAV address first.", "Roost Sync：请先填写 WebDAV 地址。"));
			return;
		}
		if (this.running) return;
		this.running = true;
		let alreadySetUp = false;
		try {
			const r = await this.buildEngine().initServer();
			await this.log("manual", r.status === "cancelled" ? "cancelled" : "initialized", r);
			if (r.status === "cancelled") {
				this.setStatus(L("Roost: cancelled", "Roost：已取消"));
			} else {
				const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
				new Notice(
					r.errors.length
						? L(`Roost Sync: server set up; ${r.errors.length} file(s) failed (see “Show sync log”).`, `Roost Sync：同步记录已建立；${r.errors.length} 个文件失败（详见「查看同步日志」）。`)
						: L("Roost Sync: server set up. Other devices can now just sync.", "Roost Sync：同步记录已建立，其他设备现在可以直接同步了。"),
					10_000,
				);
				this.setStatus(L(`Roost: synced ${now}`, `Roost：已同步 ${now}`));
			}
		} catch (e) {
			if (e instanceof AlreadyInitializedError) alreadySetUp = true;
			else if (e instanceof LockBusyError) new Notice(L(`Roost Sync: another device is syncing (${e.holder}). Try again shortly.`, `Roost Sync：其他设备正在同步（${e.holder}），请稍后再试。`), 10_000);
			else new Notice(`Roost Sync: ${e instanceof Error ? e.message : String(e)}`, 10_000);
		} finally {
			this.running = false;
		}
		// Someone else set the server up first: this device simply joins.
		if (alreadySetUp) await this.sync("manual");
	}

	private async log(trigger: string, status: string, r: SyncResult | null, errors: string[] = []) {
		const changes = (r?.actions ?? [])
			.filter((a) => ["push", "pull", "deleteLocal", "deleteRemote", "moveLocal", "moveRemote"].includes(a.kind))
			.slice(0, 200)
			.map((a) => `${a.kind} ${a.from ? `${a.from} → ` : ""}${a.path} (${a.reason})`);
		await this.stateStore
			.appendLog({
				at: Date.now(),
				trigger,
				status,
				summary: r?.summary,
				errors: [...(r?.errors ?? []), ...errors],
				warnings: r?.warnings ?? [],
				serverChanges: r?.serverChanges,
				changes,
			})
			.catch(() => {});
	}
}
