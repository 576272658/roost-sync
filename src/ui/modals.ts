import { App, Modal, Setting } from "obsidian";
import { L } from "../i18n";
import type { InitReview, PlanReview } from "../sync/engine";
import { SERVER_DIRECT, type Action, type AskChoice, type ConflictInfo, type ConflictResolution } from "../sync/types";
import type { ProbeStep } from "../webdav/probe";
import { assemble, mergeText, type HunkChoice, type MergeChunk } from "../sync/merge";
import type { SyncLogEntry } from "../obsidian/adapters";

const MAX_LIST = 300;

function list(parent: HTMLElement, title: string, paths: string[], open = false) {
	if (!paths.length) return;
	const d = parent.createEl("details", { cls: "roost-list" });
	if (open) d.open = true;
	d.createEl("summary", { text: `${title} (${paths.length})` });
	const ul = d.createEl("ul");
	for (const p of paths.slice(0, MAX_LIST)) ul.createEl("li", { text: p });
	if (paths.length > MAX_LIST) ul.createEl("li", { text: `… +${paths.length - MAX_LIST}` });
}

const ASK_LABEL: Record<string, () => string> = {
	resurrect: () => L("Edited here but deleted on another device", "本机改过，但其他设备删除了"),
	tombstoneDiffers: () => L("Deleted on another device; this copy is different", "其他设备删除了，本机这份内容不同"),
	joinLocalOnly: () => L("Only on this device (first sync / rejoin)", "只在本机存在（首次接入 / 重新加入）"),
};

/** Sync preview (§3.5). Resolves with choices for "ask" items, or null if cancelled. */
export class PlanModal extends Modal {
	private choices: Record<string, AskChoice> = {};
	private resolved = false;

	constructor(app: App, private review: PlanReview, private done: (r: Record<string, AskChoice> | null) => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		const { actions, summary, joinMode, dryRun } = this.review;
		this.titleEl.setText(dryRun ? L("Sync plan (dry run)", "同步计划（只预览，不执行）") : L("Review sync", "同步前确认"));

		if (joinMode) {
			contentEl.createEl("p", {
				cls: "roost-note",
				text: L(
					"This device is joining (new, history lost, or offline for a long time). Files that exist only here are not uploaded without your confirmation.",
					"本机处于加入模式（新设备、同步记录丢失或长期未同步）。只在本机存在的文件，需要你确认后才会上传。",
				),
			});
		}
		const by = (k: Action["kind"], f: (a: Action) => boolean = () => true) => actions.filter((a) => a.kind === k && f(a)).map((a) => a.path);
		const stats = contentEl.createDiv({ cls: "roost-stats" });
		const stat = (label: string, n: number, warn = false) => {
			if (n) stats.createDiv({ cls: warn ? "roost-stat roost-warn" : "roost-stat", text: `${label}: ${n}` });
		};
		stat(L("Upload", "上传"), summary.push - summary.pushNew - summary.resurrect);
		stat(L("Upload new", "新建上传"), summary.pushNew, true);
		stat(L("Restore deleted", "复活"), summary.resurrect, true);
		stat(L("Download", "下载"), summary.pull);
		stat(L("Move / rename", "移动 / 重命名"), summary.move);
		stat(L("Delete on this device", "删除本机文件"), summary.deleteLocal, true);
		stat(L("Delete on server", "删除服务器文件"), summary.deleteRemote, true);
		stat(L("Merge notes edited on both sides", "合并两边都改过的笔记"), summary.merge);
		stat(L("Conflicts (asked afterwards)", "冲突（同步后处理）"), summary.conflict);
		stat(L("Needs your decision", "需要你决定"), summary.ask, true);

		const asks = actions.filter((a) => a.kind === "ask");
		if (asks.length) {
			const box = contentEl.createDiv({ cls: "roost-asks" });
			box.createEl("h4", { text: L("Needs your decision", "需要你决定") });
			const bulk = new Setting(box).setName(L("Set all to", "全部设为"));
			const selects: HTMLSelectElement[] = [];
			for (const a of asks.slice(0, MAX_LIST)) {
				this.choices[a.path] = a.defaultChoice ?? "skip";
				new Setting(box)
					.setName(a.path)
					.setDesc(ASK_LABEL[a.ask!]?.() ?? a.reason)
					.addDropdown((d) => {
						d.addOption("push", a.ask === "joinLocalOnly" ? L("Upload", "上传") : L("Keep and upload", "保留并上传"))
							.addOption("deleteLocal", L("Delete here (to trash)", "删除本机（进回收站）"))
							.addOption("skip", L("Decide later", "以后再说"))
							.setValue(this.choices[a.path])
							.onChange((v) => (this.choices[a.path] = v as AskChoice));
						selects.push(d.selectEl);
					});
			}
			const setAll = (v: AskChoice) => {
				for (const a of asks) this.choices[a.path] = v;
				for (const s of selects) s.value = v;
			};
			bulk.addButton((b) => b.setButtonText(L("Upload", "上传")).onClick(() => setAll("push")));
			bulk.addButton((b) => b.setButtonText(L("Delete here", "删除本机")).onClick(() => setAll("deleteLocal")));
			bulk.addButton((b) => b.setButtonText(L("Later", "以后再说")).onClick(() => setAll("skip")));
		}

		list(contentEl, L("Delete on this device", "删除本机文件"), by("deleteLocal"), true);
		list(contentEl, L("Delete on server", "删除服务器文件"), by("deleteRemote"), true);
		list(contentEl, L("Restore deleted", "复活"), by("push", (a) => !!a.resurrect), true);
		list(contentEl, L("Upload new", "新建上传"), by("push", (a) => !!a.isNew));
		list(contentEl, L("Upload", "上传"), by("push", (a) => !a.isNew && !a.resurrect));
		list(contentEl, L("Download", "下载"), by("pull"));
		list(
			contentEl,
			L("Move / rename", "移动 / 重命名"),
			actions.filter((a) => a.kind === "moveLocal" || a.kind === "moveRemote").map((a) => `${a.from} → ${a.path}`),
		);
		list(contentEl, L("Conflicts", "冲突"), by("conflict"));

		const buttons = new Setting(contentEl);
		if (dryRun) {
			buttons.addButton((b) => b.setButtonText(L("Close", "关闭")).setCta().onClick(() => this.finish({})));
		} else {
			buttons.addButton((b) => b.setButtonText(L("Cancel", "取消")).onClick(() => this.finish(null)));
			buttons.addButton((b) => b.setButtonText(L("Sync", "开始同步")).setCta().onClick(() => this.finish(this.choices)));
		}
	}

	private finish(r: Record<string, AskChoice> | null) {
		this.resolved = true;
		this.done(r);
		this.close();
	}

	onClose() {
		if (!this.resolved) this.done(this.review.dryRun ? {} : null);
		this.contentEl.empty();
	}
}

export class InitModal extends Modal {
	private resolved = false;
	constructor(app: App, private review: InitReview, private done: (r: "trash" | "download" | null) => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		const { upload, identical, remoteOnly } = this.review;
		this.titleEl.setText(L("First sync: set up the server from this device", "首次同步：以本机为基准建立同步记录"));
		contentEl.createEl("p", {
			text: L(
				"This server folder has no Roost Sync records yet. This device's notes and settings become the reference; this is needed only once, other devices then just sync.",
				"这个服务器目录还没有 Roost Sync 的同步记录。本机的笔记和设置将作为基准，只需要做这一次，之后其他设备直接同步即可。",
			),
		});
		contentEl.createEl("p", { text: L(`Already identical on server: ${identical.length}`, `服务器上已有且相同：${identical.length}`) });
		list(contentEl, L("Will upload", "将上传"), upload);
		if (remoteOnly.length) {
			contentEl.createEl("p", {
				cls: "roost-note",
				text: L(
					"These files are on the server but not on this device. “Move to server trash” records them as deleted, so other devices drop identical stale copies automatically.",
					"下面这些文件服务器上有、本机没有。选「移到服务器回收站」会把它们记为已删除，其他设备上内容相同的旧副本会被自动清理。",
				),
			});
			list(contentEl, L("Only on server", "只在服务器上"), remoteOnly, true);
		}
		const b = new Setting(contentEl);
		b.addButton((x) => x.setButtonText(L("Cancel", "取消")).onClick(() => this.finish(null)));
		if (remoteOnly.length) {
			b.addButton((x) => x.setButtonText(L("Download them here", "下载到本机")).onClick(() => this.finish("download")));
			b.addButton((x) => x.setButtonText(L("Move to server trash", "移到服务器回收站")).setCta().onClick(() => this.finish("trash")));
		} else {
			b.addButton((x) => x.setButtonText(L("Start syncing", "开始同步")).setCta().onClick(() => this.finish("trash")));
		}
	}

	private finish(r: "trash" | "download" | null) {
		this.resolved = true;
		this.done(r);
		this.close();
	}

	onClose() {
		if (!this.resolved) this.done(null);
		this.contentEl.empty();
	}
}

const TEXT_EXT = /\.(md|txt|canvas|json|css|js|csv|html?|xml|ya?ml|svg)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/** Conflict resolver (§5.8): whole-file choice in M1. */
type ConflictChoice = "local" | "remote" | "merge" | "later";

interface HunkMerge {
	chunks: MergeChunk[];
	choices: HunkChoice[];
}

export class ConflictModal extends Modal {
	private choices: Record<string, ConflictChoice> = {};
	private merges: Record<string, HunkMerge> = {};
	private urls: string[] = [];

	constructor(
		app: App,
		private conflicts: ConflictInfo[],
		private load: (c: ConflictInfo) => Promise<{ local: ArrayBuffer | null; remote: ArrayBuffer | null }>,
		private loadMerge: (c: ConflictInfo) => Promise<{ local: string; base: string; remote: string } | null>,
		private apply: (res: Record<string, ConflictResolution>, mergedTexts: Record<string, string>) => Promise<void>,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("roost-conflict-modal");
		this.titleEl.setText(L(`Sync conflicts (${this.conflicts.length})`, `同步冲突（${this.conflicts.length}）`));
		contentEl.createEl("p", {
			cls: "roost-note",
			text: L(
				"These files were changed on this device and on another one. Pick the version to keep, or for notes, merge them section by section. The versions you replace are archived in the server's .sync/conflicts/. Until you decide, the file is left as is on both sides.",
				"这些文件在本机和其他设备上都被改过。选择要保留的版本；笔记也可以逐段合并。被替换的版本会归档到服务器的 .sync/conflicts/。在你决定之前，两边的文件都保持原样。",
			),
		});
		const radios: Record<string, Partial<Record<ConflictChoice, HTMLInputElement>>> = {};
		for (const c of this.conflicts) {
			this.choices[c.path] = "later";
			const box = contentEl.createDiv({ cls: "roost-conflict" });
			box.createEl("h4", { text: c.path });
			const time = (t: number) => (t ? new Date(t).toLocaleString() : "?");
			const row = box.createDiv({ cls: "roost-choice-row" });
			const mergeEl = box.createDiv({ cls: "roost-merge" });
			const opt = (value: ConflictChoice, label: string) => {
				const l = row.createEl("label");
				const r = l.createEl("input", { type: "radio" });
				r.name = `c-${c.path}`;
				r.checked = value === "later";
				r.onchange = () => {
					this.choices[c.path] = value;
					if (value === "merge") void this.showMerge(c, mergeEl, () => radios[c.path].later?.click());
					else mergeEl.empty();
				};
				(radios[c.path] ??= {})[value] = r;
				l.appendText(" " + label);
			};
			opt("local", L(`This device (${time(c.localMtime)}, ${c.localSize} B)`, `本机（${time(c.localMtime)}，${c.localSize} 字节）`));
			const by = c.remoteBy === SERVER_DIRECT ? L("edited directly on the server", "直接在服务器上修改") : c.remoteBy;
			opt("remote", L(`Server, ${by} (${time(c.remoteMtime)}, ${c.remoteSize} B)`, `服务器，来自 ${by}（${time(c.remoteMtime)}，${c.remoteSize} 字节）`));
			if (c.mergeable) opt("merge", L("Merge section by section", "逐段合并"));
			opt("later", L("Decide later", "以后再说"));

			const preview = box.createDiv({ cls: "roost-diff" });
			const btn = box.createEl("button", { text: L("Compare", "对比内容") });
			btn.onclick = async () => {
				btn.remove();
				preview.setText(L("Loading…", "加载中…"));
				const { local, remote } = await this.load(c);
				preview.empty();
				for (const [label, data] of [[L("This device", "本机"), local], [L("Server", "服务器"), remote]] as const) {
					const col = preview.createDiv({ cls: "roost-diff-col" });
					col.createEl("strong", { text: label });
					if (!data) col.createEl("p", { text: L("(unavailable)", "（无法读取）") });
					else if (IMAGE_EXT.test(c.path)) {
						const url = URL.createObjectURL(new Blob([data]));
						this.urls.push(url);
						col.createEl("img", { attr: { src: url } });
					} else if (TEXT_EXT.test(c.path)) col.createEl("pre", { text: new TextDecoder().decode(data) });
					else col.createEl("p", { text: `${data.byteLength} B` });
				}
			};
		}
		const setAll = (v: "local" | "remote") => {
			for (const c of this.conflicts) radios[c.path][v]?.click();
		};
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(L("All: this device", "全部用本机")).onClick(() => setAll("local")))
			.addButton((b) => b.setButtonText(L("All: server", "全部用服务器")).onClick(() => setAll("remote")))
			.addButton((b) =>
				b
					.setButtonText(L("Apply", "确定"))
					.setCta()
					.onClick(() => {
						const res: Record<string, ConflictResolution> = {};
						const mergedTexts: Record<string, string> = {};
						for (const c of this.conflicts) {
							const v = this.choices[c.path];
							if (v === "later") continue;
							if (v === "merge") {
								const m = this.merges[c.path];
								if (!m) continue;
								res[c.path] = { choice: "merged", remoteHash: c.remoteHash, localHash: c.localHash };
								mergedTexts[c.path] = assemble(m.chunks, m.choices);
							} else res[c.path] = { choice: v, remoteHash: c.remoteHash };
						}
						this.close();
						if (Object.keys(res).length) void this.apply(res, mergedTexts);
					}),
			);
	}

	/** Hunk-by-hunk merge: parts changed on only one side are already merged; each overlap gets a choice. */
	private async showMerge(c: ConflictInfo, el: HTMLElement, cancel: () => void) {
		el.empty();
		el.setText(L("Loading…", "加载中…"));
		const inputs = await this.loadMerge(c);
		el.empty();
		if (!inputs) {
			el.createEl("p", {
				cls: "roost-warn-text",
				text: L("The file changed since this conflict was found. Sync again, then merge.", "发现冲突之后文件又有变化。请先再同步一次，然后再合并。"),
			});
			cancel();
			return;
		}
		const chunks = mergeText(inputs.local, inputs.base, inputs.remote);
		const m: HunkMerge = { chunks, choices: chunks.filter((x) => "conflict" in x).map((): HunkChoice => "localFirst") };
		this.merges[c.path] = m;
		el.createEl("p", {
			cls: "roost-note",
			text: L(
				`Edits made on only one side are already merged. ${m.choices.length} section(s) were changed on both sides; choose what to keep for each.`,
				`只在一边改过的内容已经自动合并。有 ${m.choices.length} 处两边都改了，请逐处选择保留哪个。`,
			),
		});
		const result = el.createEl("details", { cls: "roost-merge-result" });
		result.createEl("summary", { text: L("Merged result", "合并结果预览") });
		const resultPre = result.createEl("pre");
		const refresh = () => resultPre.setText(assemble(m.chunks, m.choices));

		let hunk = 0;
		let before: string[] = [];
		for (const ch of chunks) {
			if ("ok" in ch) {
				before = ch.ok;
				continue;
			}
			const i = hunk++;
			const box = el.createDiv({ cls: "roost-hunk" });
			const context = before.slice(-2).join("\n").trim();
			box.createDiv({ cls: "roost-hunk-title", text: L(`Section ${i + 1}`, `第 ${i + 1} 处`) });
			if (context) box.createEl("pre", { cls: "roost-hunk-context", text: context });
			const cols = box.createDiv({ cls: "roost-diff" });
			for (const [label, text] of [[L("This device", "本机"), ch.conflict.local], [L("Server", "服务器"), ch.conflict.remote]] as const) {
				const col = cols.createDiv({ cls: "roost-diff-col" });
				col.createEl("strong", { text: label });
				col.createEl("pre", { text: text.join("\n") || L("(removed)", "（已删除）") });
			}
			new Setting(box).setName(L("Keep", "保留")).addDropdown((d) =>
				d
					.addOptions({
						localFirst: L("Both: this device first", "两者都保留：本机在前"),
						remoteFirst: L("Both: server first", "两者都保留：服务器在前"),
						local: L("This device", "本机"),
						remote: L("Server", "服务器"),
					})
					.setValue(m.choices[i])
					.onChange((v) => {
						m.choices[i] = v as HunkChoice;
						refresh();
					}),
			);
		}
		refresh();
	}

	onClose() {
		for (const u of this.urls) URL.revokeObjectURL(u);
		this.contentEl.empty();
	}
}

export class ProbeModal extends Modal {
	constructor(app: App, private run: () => Promise<ProbeStep[]>) {
		super(app);
	}

	async onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(L("Connection test", "连接测试"));
		const status = contentEl.createEl("p", { text: L("Testing…", "测试中…") });
		const steps = await this.run();
		status.remove();
		const ul = contentEl.createEl("ul", { cls: "roost-probe" });
		for (const s of steps) {
			const li = ul.createEl("li");
			li.setText(`${s.ok ? "✅" : s.required ? "❌" : "⚠️"} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
		}
		const fatal = steps.some((s) => !s.ok && s.required);
		contentEl.createEl("p", {
			text: fatal
				? L("This server cannot be used safely yet. Fix the ❌ items first.", "这个服务器暂时无法安全使用，请先解决 ❌ 项。")
				: L("All required checks passed.", "必需项全部通过。"),
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

export class LogModal extends Modal {
	constructor(app: App, private entries: SyncLogEntry[]) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(L("Sync log", "同步日志"));
		const pre = this.contentEl.createEl("pre", { cls: "roost-log" });
		pre.setText(
			this.entries
				.map((e) => {
					const lines = [`[${new Date(e.at).toLocaleString()}] ${e.trigger} → ${e.status}${e.summary ? ` ${JSON.stringify(e.summary)}` : ""}`];
					for (const x of e.errors ?? []) lines.push(`  ✗ ${x}`);
					for (const x of e.warnings ?? []) lines.push(`  ! ${x}`);
					const sc = e.serverChanges;
					if (sc && sc.created.length + sc.modified.length + sc.deleted.length + (sc.moved?.length ?? 0)) {
						lines.push(L("  Changed directly on the server:", "  服务器目录上的直接修改："));
						for (const x of sc.created) lines.push(`    + ${x}`);
						for (const x of sc.modified) lines.push(`    ~ ${x}`);
						for (const x of sc.deleted) lines.push(`    - ${x}`);
						for (const x of sc.moved ?? []) lines.push(`    → ${x}`);
					}
					for (const x of e.changes ?? []) lines.push(`  · ${x}`);
					return lines.join("\n");
				})
				.join("\n\n") || L("No syncs yet.", "还没有同步记录。"),
		);
	}
	onClose() {
		this.contentEl.empty();
	}
}
