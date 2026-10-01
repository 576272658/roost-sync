import { Notice, Platform, Plugin, TAbstractFile, debounce, normalizePath } from "obsidian";
import { L } from "./i18n";
import { FileStateStore, VaultFs, obsidianTransport, platformName } from "./obsidian/adapters";
import { DEFAULT_SETTINGS, RoostSettingTab, type RoostSettings } from "./settings";
import { NotInitializedError, SyncEngine, type SyncResult, type SyncUI } from "./sync/engine";
import { LockBusyError, RemoteRepo } from "./sync/remote";
import type { ConflictInfo } from "./sync/types";
import { ConflictModal, InitModal, LogModal, PlanModal, ProbeModal } from "./ui/modals";
import { randomId } from "./util/hash";
import { IgnoreRules } from "./util/paths";
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
				window.setTimeout(() => this.sync("startup"), this.settings.startupDelaySec * 1000);
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
		const data = (await this.loadData()) ?? {};
		this.settings = {
			...DEFAULT_SETTINGS,
			remoteFolder: this.app.vault.getName(),
			deviceId: randomId(),
			deviceName: platformName(),
			...data,
		};
		if (!data.deviceId) await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	rescheduleTimers() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		const m = this.settings?.intervalMinutes ?? 0;
		if (m > 0) {
			this.intervalId = window.setInterval(() => this.sync("interval"), m * 60_000);
			this.registerInterval(this.intervalId);
		}
	}

	private onVaultEdit(_f: TAbstractFile) {
		const sec = this.settings.syncAfterEditSec;
		if (!sec || this.running || !this.configured()) return;
		if (this.editTimer) window.clearTimeout(this.editTimer);
		this.editTimer = window.setTimeout(() => this.sync("edit"), sec * 1000);
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
		return new SyncEngine(new VaultFs(this.app), this.stateStore, remote, fullUi, {
			device: { id: s.deviceId, name: s.deviceName, platform: platformName() },
			pluginVersion: this.manifest.version,
			// The plugin's own folder lives under the config dir, which starts with a dot and is always ignored.
			ignore: new IgnoreRules(s.ignorePatterns.split("\n")),
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
		try {
			result = await this.buildEngine().sync({ dryRun });
		} catch (e) {
			if (e instanceof LockBusyError) {
				failure = L(`Another device is syncing (${e.holder}). Will retry shortly.`, `其他设备正在同步（${e.holder}），稍后自动重试。`);
				if (trigger !== "conflict") window.setTimeout(() => this.sync(trigger === "manual" ? "manual" : "interval"), 20_000);
			} else if (e instanceof NotInitializedError) {
				failure = L(
					"The server is not initialized yet. Run “Initialize server from this device” on your most complete device.",
					"服务器还没有初始化。请在最新、最完整的那台设备上执行「从本机初始化服务器」。",
				);
			} else {
				failure = e instanceof Error ? e.message : String(e);
				console.error("Roost Sync", e);
			}
		} finally {
			this.running = false;
		}

		const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		if (failure) {
			this.setStatus(L(`Roost: failed ${now}`, `Roost：同步失败 ${now}`));
			if (!quiet || !(failure.includes("syncing") || failure.includes("正在同步"))) new Notice(`Roost Sync: ${failure}`, 10_000);
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
		const changed = s.push + s.pull + s.deleteLocal + s.deleteRemote;
		if (changed > 0 && !quiet) {
			const parts = [
				s.push && L(`↑${s.push}`, `↑${s.push}`),
				s.pull && L(`↓${s.pull}`, `↓${s.pull}`),
				s.deleteLocal + s.deleteRemote && L(`deleted ${s.deleteLocal + s.deleteRemote}`, `删除 ${s.deleteLocal + s.deleteRemote}`),
			].filter(Boolean);
			new Notice(`Roost Sync: ${parts.join("  ")}`);
		}
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
	}

	private setConflicts(list: ConflictInfo[], maybeOpen: boolean, force = false) {
		this.conflicts = list;
		if (!list.length) return;
		this.setStatus(L(`Roost: ${list.length} conflict(s)`, `Roost：${list.length} 个冲突待处理`));
		const key = list.map((c) => `${c.path}:${c.localHash}:${c.remoteHash}`).sort().join("|");
		if (maybeOpen && (force || key !== this.lastShownConflicts)) {
			this.lastShownConflicts = key;
			this.openConflicts();
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
		try {
			const r = await this.buildEngine().initServer();
			await this.log("manual", r.status === "cancelled" ? "cancelled" : "initialized", r);
			if (r.status !== "cancelled") {
				new Notice(
					L(`Roost Sync: server initialized. ${r.errors.length} error(s).`, `Roost Sync：服务器初始化完成。${r.errors.length} 个错误。`),
				);
				this.setStatus(L("Roost: initialized", "Roost：已初始化"));
			}
		} catch (e) {
			new Notice(`Roost Sync: ${e instanceof Error ? e.message : String(e)}`, 10_000);
		} finally {
			this.running = false;
		}
	}

	private async log(trigger: string, status: string, r: SyncResult | null, errors: string[] = []) {
		const changes = (r?.actions ?? [])
			.filter((a) => ["push", "pull", "deleteLocal", "deleteRemote"].includes(a.kind))
			.slice(0, 200)
			.map((a) => `${a.kind} ${a.path} (${a.reason})`);
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
