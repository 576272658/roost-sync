import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomId } from "../src/util/hash";
import { LockBusyError } from "../src/sync/remote";
import { NotInitializedError } from "../src/sync/engine";
import { device, hasUvx, startWsgiDav } from "./helpers";

describe.skipIf(!hasUvx)("sync against WsgiDAV 4.3.3", () => {
	let server: Awaited<ReturnType<typeof startWsgiDav>>;
	let folder: string;
	const mk = (name: string) => device(server.url, folder, name);

	beforeAll(async () => {
		server = await startWsgiDav();
	}, 120_000);
	afterAll(() => server?.stop());
	beforeEach(() => {
		folder = `vault-${randomId().slice(0, 8)}`;
	});

	async function setup() {
		const mac = mk("mac");
		mac.fs.set("notes/a.md", "A");
		mac.fs.set("notes/b.md", "B");
		mac.fs.set("中文 😀/笔记.md", "你好");
		await mac.engine.initServer();
		const phone = mk("phone");
		await phone.engine.sync();
		return { mac, phone };
	}

	it("refuses to sync before initialization", async () => {
		await expect(mk("x").engine.sync()).rejects.toBeInstanceOf(NotInitializedError);
	});

	it("initializes and a new device pulls everything", async () => {
		const { phone } = await setup();
		expect(phone.fs.text("notes/a.md")).toBe("A");
		expect(phone.fs.text("中文 😀/笔记.md")).toBe("你好");
	});

	it("propagates edits and deletions both ways", async () => {
		const { mac, phone } = await setup();
		phone.fs.set("notes/a.md", "A2");
		phone.fs.remove("notes/b.md");
		phone.fs.set("notes/c.md", "C");
		const r = await phone.engine.sync();
		expect(r.summary).toMatchObject({ push: 2, deleteRemote: 1 });
		await mac.engine.sync();
		expect(mac.fs.text("notes/a.md")).toBe("A2");
		expect(mac.fs.text("notes/b.md")).toBeUndefined();
		expect(mac.fs.trashed).toContain("notes/b.md");
		expect(mac.fs.text("notes/c.md")).toBe("C");
	});

	it("a stale device does not resurrect files deleted elsewhere (the original bug)", async () => {
		const { mac, phone } = await setup();
		// mac deletes while the phone is offline; the phone's copies get their mtime bumped.
		mac.fs.remove("notes/a.md");
		mac.fs.remove("notes/b.md");
		await mac.engine.sync();
		phone.fs.touch("notes/a.md");
		const r = await phone.engine.sync();
		expect(r.summary.push).toBe(0);
		expect(phone.fs.text("notes/a.md")).toBeUndefined();
		expect(phone.fs.text("notes/b.md")).toBeUndefined();
	});

	it("even with all local state lost, stale copies are removed, not pushed", async () => {
		const { mac, phone } = await setup();
		mac.fs.remove("notes/a.md");
		await mac.engine.sync();
		phone.store.state = null; // reinstall / storage wiped
		phone.fs.set("notes/new-on-phone.md", "N");
		const r = await phone.engine.sync();
		expect(r.joinMode).toBe(true);
		expect(phone.fs.text("notes/a.md")).toBeUndefined();
		// Local-only file in join mode is asked about, not silently pushed.
		const asked = phone.ui.reviews.flatMap((rv) => rv.actions.filter((a) => a.kind === "ask").map((a) => a.path));
		expect(asked).toEqual(["notes/new-on-phone.md"]);
	});

	it("join mode: skipped items are asked again next time", async () => {
		const { phone } = await setup();
		phone.store.state = null;
		phone.fs.set("x.md", "X");
		phone.ui.answer = () => ({ "x.md": "skip" });
		await phone.engine.sync();
		phone.ui.answer = () => ({});
		const before = phone.ui.reviews.length;
		await phone.engine.sync();
		expect(phone.ui.reviews.length).toBe(before + 1);
	});

	it("conflicts leave both sides untouched until resolved", async () => {
		const { mac, phone } = await setup();
		mac.fs.set("notes/a.md", "from mac");
		await mac.engine.sync();
		phone.fs.set("notes/a.md", "from phone");
		const r = await phone.engine.sync();
		expect(r.conflicts.map((c) => c.path)).toEqual(["notes/a.md"]);
		expect(phone.fs.text("notes/a.md")).toBe("from phone");
		expect(await phone.dav.getText("notes/a.md")).toBe("from mac");

		await phone.engine.saveResolutions({ "notes/a.md": { choice: "local", remoteHash: r.conflicts[0].remoteHash } });
		const r2 = await phone.engine.sync();
		expect(r2.conflicts).toHaveLength(0);
		expect(await phone.dav.getText("notes/a.md")).toBe("from phone");
		await mac.engine.sync();
		expect(mac.fs.text("notes/a.md")).toBe("from phone");
		const archived = await phone.dav.walk(".sync/conflicts");
		expect(archived.map((e) => e.path.split("/").slice(3).join("/"))).toEqual(["notes/a.md"]);
	});

	it("notes edited in different paragraphs on two devices are merged", async () => {
		const { mac, phone } = await setup();
		const base = "# Note\n\nfirst paragraph\n\nsecond paragraph\n\nthird paragraph\n";
		mac.fs.set("notes/m.md", base);
		await mac.engine.sync();
		await phone.engine.sync();
		mac.fs.set("notes/m.md", base.replace("first paragraph", "first paragraph, edited on mac"));
		await mac.engine.sync();
		phone.fs.set("notes/m.md", base.replace("third paragraph", "third paragraph, edited on phone"));
		const r = await phone.engine.sync();
		const merged = "# Note\n\nfirst paragraph, edited on mac\n\nsecond paragraph\n\nthird paragraph, edited on phone\n";
		expect(r.conflicts).toHaveLength(0);
		expect(r.actions.filter((a) => a.merged).map((a) => a.path)).toEqual(["notes/m.md"]);
		expect(phone.fs.text("notes/m.md")).toBe(merged);
		expect(await phone.dav.getText("notes/m.md")).toBe(merged);
		const archived = (await phone.dav.walk(".sync/conflicts")).map((e) => e.path.split("/").slice(3).join("/")).sort();
		expect(archived).toEqual(["notes/m (mac).md", "notes/m (phone).md"]);

		const r2 = await mac.engine.sync();
		expect(r2.conflicts).toHaveLength(0);
		expect(mac.fs.text("notes/m.md")).toBe(merged);
		// The merged text is the new base: the next concurrent edits merge again.
		mac.fs.set("notes/m.md", merged.replace("second paragraph", "second paragraph (mac)"));
		await mac.engine.sync();
		phone.fs.set("notes/m.md", merged + "\nappended on phone\n");
		const r3 = await phone.engine.sync();
		expect(r3.conflicts).toHaveLength(0);
		expect(phone.fs.text("notes/m.md")).toBe(merged.replace("second paragraph", "second paragraph (mac)") + "\nappended on phone\n");
	});

	it("overlapping edits become a conflict that can be merged section by section", async () => {
		const { mac, phone } = await setup();
		const base = "intro\n\nshared line\n\noutro\n";
		mac.fs.set("notes/m.md", base);
		await mac.engine.sync();
		await phone.engine.sync();
		mac.fs.set("notes/m.md", base.replace("shared line", "mac line").replace("outro", "outro (mac)"));
		await mac.engine.sync();
		phone.fs.set("notes/m.md", base.replace("shared line", "phone line"));
		const r = await phone.engine.sync();
		expect(r.conflicts.map((c) => [c.path, c.mergeable])).toEqual([["notes/m.md", true]]);
		expect(phone.fs.text("notes/m.md")).toBe(base.replace("shared line", "phone line"));

		// A second sync does not retry the merge (no server work for it).
		const again = await phone.engine.sync();
		expect(again.conflicts.map((c) => c.path)).toEqual(["notes/m.md"]);

		const c = again.conflicts[0];
		const inputs = await phone.engine.loadMergeInputs(c);
		expect(inputs?.base).toBe(base);
		const { assemble, mergeText } = await import("../src/sync/merge");
		const text = assemble(mergeText(inputs!.local, inputs!.base, inputs!.remote), ["remoteFirst"]);
		await phone.engine.saveResolutions({ "notes/m.md": { choice: "merged", remoteHash: c.remoteHash, localHash: c.localHash } }, { "notes/m.md": text });
		const r2 = await phone.engine.sync();
		expect(r2.conflicts).toHaveLength(0);
		const expected = "intro\n\nmac line\nphone line\n\noutro (mac)\n";
		expect(phone.fs.text("notes/m.md")).toBe(expected);
		await mac.engine.sync();
		expect(mac.fs.text("notes/m.md")).toBe(expected);
	});

	it("notes synced before the upgrade get a base text, and unused texts are dropped", async () => {
		const { mac, phone } = await setup();
		phone.texts.texts.clear();
		await phone.engine.sync();
		expect(phone.texts.texts.size).toBe(3); // a.md, b.md, 笔记.md
		mac.fs.remove("notes/b.md");
		await mac.engine.sync();
		await phone.engine.sync();
		expect(phone.texts.texts.size).toBe(2);
	});

	it("same edit on both sides is not a conflict", async () => {
		const { mac, phone } = await setup();
		mac.fs.set("notes/a.md", "same");
		await mac.engine.sync();
		phone.fs.set("notes/a.md", "same");
		const r = await phone.engine.sync();
		expect(r.conflicts).toHaveLength(0);
	});

	it("an external edit between planning and writing is not overwritten", async () => {
		const { mac, phone } = await setup();
		mac.fs.set("notes/a.md", "from mac");
		await mac.engine.sync();
		// An agent rewrites the file on the phone right after the scan, keeping size and mtime.
		const realRead = phone.fs.read.bind(phone.fs);
		let reads = 0;
		phone.fs.read = async (p: string) => {
			if (p === "notes/a.md" && ++reads === 2) phone.fs.files.get(p)!.data = new TextEncoder().encode("X");
			return realRead(p);
		};
		phone.fs.touch("notes/a.md"); // force a fresh hash in the scan (read #1)
		const r = await phone.engine.sync();
		expect(phone.fs.text("notes/a.md")).toBe("X");
		expect(r.errors.some((e) => e.includes("edited during sync"))).toBe(true);
	});

	it("a file that vanishes during the scan is skipped, not treated as deleted", async () => {
		const { phone } = await setup();
		phone.fs.touch("notes/a.md");
		phone.fs.read = async (p: string) => {
			throw new Error(`ENOENT ${p}`);
		};
		const r = await phone.engine.sync();
		expect(r.summary.deleteRemote).toBe(0);
		expect(await phone.dav.getText("notes/a.md")).toBe("A");
	});

	it("mtime-only change is not an edit", async () => {
		const { phone } = await setup();
		phone.fs.touch("notes/a.md");
		const r = await phone.engine.sync();
		expect(r.status).toBe("nothing-to-do");
	});

	it("mass deletion triggers the preview and can be cancelled", async () => {
		const { mac, phone } = await setup();
		for (let i = 0; i < 20; i++) mac.fs.set(`bulk/${i}.md`, String(i));
		mac.ui.answer = () => ({});
		await mac.engine.sync();
		await phone.engine.sync();
		for (let i = 0; i < 20; i++) phone.fs.remove(`bulk/${i}.md`);
		phone.ui.answer = () => null;
		const r = await phone.engine.sync();
		expect(r.status).toBe("cancelled");
		expect(await phone.dav.getText("bulk/3.md")).toBe("3");
	});

	it("remote deletes go to server trash and empty folders are removed", async () => {
		const { mac } = await setup();
		mac.fs.remove("中文 😀/笔记.md");
		await mac.engine.sync();
		const trash = await mac.dav.walk(".sync/trash");
		expect(trash.some((e) => e.path.endsWith("中文 😀/笔记.md"))).toBe(true);
		expect(await mac.dav.propfind("中文 😀", 1)).toBeNull();
	});

	it("case-only rename on one device", async () => {
		const { mac, phone } = await setup();
		mac.fs.remove("notes/a.md");
		mac.fs.set("notes/A.md", "A");
		await mac.engine.sync();
		await phone.engine.sync();
		expect(phone.fs.text("notes/A.md")).toBe("A");
		expect(phone.fs.text("notes/a.md")).toBeUndefined();
	});

	it("lock blocks a second device and is released afterwards", async () => {
		const { mac, phone } = await setup();
		await mac.remote.acquireLock();
		phone.fs.set("notes/a.md", "x");
		await expect(phone.engine.sync()).rejects.toBeInstanceOf(LockBusyError);
		await mac.remote.releaseLock();
		await expect(phone.engine.sync()).resolves.toMatchObject({ status: "synced" });
	});

	it("init: files only on the server are trashed with tombstones so other devices drop them", async () => {
		const old = mk("old-tool");
		await old.dav.ensureRoot();
		await old.dav.put("zombie.md", "Z");
		await old.dav.put("keep.md", "K");
		const mac = mk("mac");
		mac.fs.set("keep.md", "K");
		await mac.engine.initServer();
		const ipad = mk("ipad");
		ipad.fs.set("zombie.md", "Z");
		ipad.fs.set("keep.md", "K");
		await ipad.engine.sync();
		expect(ipad.fs.text("zombie.md")).toBeUndefined();
		expect(ipad.fs.text("keep.md")).toBe("K");
	});

	it("manifest ETag changes even when rewritten within the same second at the same size", async () => {
		const { mac, phone } = await setup();
		mac.fs.set("notes/a.md", "1");
		await mac.engine.sync();
		mac.fs.set("notes/a.md", "2");
		await mac.engine.sync();
		// phone holds the manifest cached from setup; it must see the latest content.
		await phone.engine.sync();
		expect(phone.fs.text("notes/a.md")).toBe("2");
	});
});

describe.skipIf(!hasUvx)("connection test against WsgiDAV 4.3.3", () => {
	it("passes every check", async () => {
		const { probeServer } = await import("../src/webdav/probe");
		const { WebDavClient } = await import("../src/webdav/client");
		const { fetchTransport } = await import("./helpers");
		const server = await startWsgiDav();
		try {
			const steps = await probeServer(new WebDavClient(fetchTransport, server.url, "probe vault"), (en) => en);
			expect(steps.filter((s) => !s.ok)).toEqual([]);
			expect(steps.length).toBeGreaterThanOrEqual(8);
		} finally {
			server.stop();
		}
	}, 120_000);
});

describe.skipIf(!hasUvx)("server folder edited directly (AI agent) — reconciliation", () => {
	let server: Awaited<ReturnType<typeof startWsgiDav>>;
	let folder: string;
	const mk = (name: string) => device(server.url, folder, name);
	const disk = (rel: string) => join(server.root, folder, rel);
	const agentWrite = (rel: string, text: string) => {
		mkdirSync(dirname(disk(rel)), { recursive: true });
		writeFileSync(disk(rel), text);
	};

	beforeAll(async () => {
		server = await startWsgiDav();
	}, 120_000);
	afterAll(() => server?.stop());
	beforeEach(() => {
		folder = `vault-${randomId().slice(0, 8)}`;
	});

	async function setup() {
		const mac = mk("mac");
		mac.fs.set("notes/a.md", "A");
		mac.fs.set("notes/b.md", "B");
		for (let i = 0; i < 20; i++) mac.fs.set(`pile/${i}.md`, `pile ${i}`);
		await mac.engine.initServer();
		const phone = mk("phone");
		await phone.engine.sync();
		return { mac, phone };
	}

	it("agent creates, edits and deletes files; every device follows", async () => {
		const { mac, phone } = await setup();
		agentWrite("agent/new 笔记.md", "written by agent");
		agentWrite("notes/a.md", "A edited by agent");
		unlinkSync(disk("notes/b.md"));
		const r = await phone.engine.sync();
		expect(r.serverChanges).toEqual({ created: ["agent/new 笔记.md"], modified: ["notes/a.md"], deleted: ["notes/b.md"], moved: [] });
		expect(phone.fs.text("agent/new 笔记.md")).toBe("written by agent");
		expect(phone.fs.text("notes/a.md")).toBe("A edited by agent");
		expect(phone.fs.text("notes/b.md")).toBeUndefined();
		expect(phone.fs.trashed).toContain("notes/b.md");
		// The other device gets the same result from the committed manifest.
		const r2 = await mac.engine.sync();
		expect(r2.serverChanges.created.length + r2.serverChanges.modified.length + r2.serverChanges.deleted.length).toBe(0);
		expect(mac.fs.text("agent/new 笔记.md")).toBe("written by agent");
		expect(mac.fs.text("notes/a.md")).toBe("A edited by agent");
		expect(mac.fs.text("notes/b.md")).toBeUndefined();
	});

	it("a device with lost state still drops a copy the agent deleted (tombstone has the old hash)", async () => {
		const { mac, phone } = await setup();
		unlinkSync(disk("notes/a.md"));
		await mac.engine.sync();
		phone.store.state = null;
		await phone.engine.sync();
		expect(phone.fs.text("notes/a.md")).toBeUndefined();
	});

	it("agent touching a file (same content) changes nothing, and is not re-downloaded later", async () => {
		const { phone } = await setup();
		const future = new Date(Date.now() + 5000);
		utimesSync(disk("notes/a.md"), future, future);
		const r = await phone.engine.sync();
		expect(r.summary.pull).toBe(0);
		expect(r.serverChanges.modified).toEqual([]);
		const r2 = await phone.engine.sync();
		expect(r2.status).toBe("nothing-to-do");
	});

	it("our own uploads are not mistaken for agent edits", async () => {
		const { phone } = await setup();
		phone.fs.set("notes/a.md", "phone edit");
		phone.fs.set("notes/c.md", "new");
		await phone.engine.sync();
		const r = await phone.engine.sync();
		expect(r.status).toBe("nothing-to-do");
		expect(r.serverChanges).toEqual({ created: [], modified: [], deleted: [], moved: [] });
	});

	it("agent and a device editing the same note → conflict, nothing overwritten", async () => {
		const { phone } = await setup();
		agentWrite("notes/a.md", "agent version");
		phone.fs.set("notes/a.md", "phone version");
		const r = await phone.engine.sync();
		expect(r.conflicts.map((c) => c.path)).toEqual(["notes/a.md"]);
		expect(readFileSync(disk("notes/a.md"), "utf8")).toBe("agent version");
		expect(phone.fs.text("notes/a.md")).toBe("phone version");
	});

	it("agent writes the file right before our upload → upload refused (If-Match), agent's text kept", async () => {
		const { phone } = await setup();
		phone.fs.set("notes/a.md", "phone version");
		const realRead = phone.fs.read.bind(phone.fs);
		let reads = 0;
		phone.fs.read = async (p: string) => {
			// Read #1 is the scan; #2 is doPush right before the PUT (after the locked
			// reconciliation): the agent strikes in between.
			if (p === "notes/a.md" && ++reads === 2) agentWrite("notes/a.md", "agent wrote this meanwhile");
			return realRead(p);
		};
		const r = await phone.engine.sync();
		expect(readFileSync(disk("notes/a.md"), "utf8")).toBe("agent wrote this meanwhile");
		expect(r.errors.some((e) => e.includes("changed on the server during sync"))).toBe(true);
		phone.fs.read = realRead;
		const r2 = await phone.engine.sync();
		expect(r2.conflicts.map((c) => c.path)).toEqual(["notes/a.md"]);
	});

	it("agent mass-deleting files triggers the preview", async () => {
		const { phone } = await setup();
		for (let i = 0; i < 15; i++) unlinkSync(disk(`pile/${i}.md`));
		phone.ui.answer = () => null;
		const r = await phone.engine.sync();
		expect(r.status).toBe("cancelled");
		expect(phone.fs.text("pile/3.md")).toBe("pile 3");
	});

	it("an emptied server folder is refused, not treated as mass deletion", async () => {
		const { phone } = await setup();
		for (const d of ["notes", "pile"]) rmSync(disk(d), { recursive: true });
		await expect(phone.engine.sync()).rejects.toThrow(/looks empty/);
		expect(phone.fs.text("notes/a.md")).toBe("A");
	});

	it("can be turned off", async () => {
		const { phone } = await setup();
		(phone.engine as any).settings.detectServerChanges = false;
		agentWrite("agent.md", "x");
		const r = await phone.engine.sync();
		expect(r.status).toBe("nothing-to-do");
	});
});

describe.skipIf(!hasUvx)("renames and config sync", () => {
	let server: Awaited<ReturnType<typeof startWsgiDav>>;
	let folder: string;
	const disk = (rel: string) => join(server.root, folder, rel);

	beforeAll(async () => {
		server = await startWsgiDav();
	}, 120_000);
	afterAll(() => server?.stop());
	beforeEach(() => {
		folder = `vault-${randomId().slice(0, 8)}`;
	});

	async function setup(config = false) {
		const mac = device(server.url, folder, "mac", { config });
		for (let i = 0; i < 20; i++) mac.fs.set(`projects/${i}.md`, `note ${i}`);
		mac.fs.set("keep.md", "K");
		if (config) {
			mac.fs.set(".obsidian/app.json", '{"a":1}');
			mac.fs.set(".obsidian/community-plugins.json", '["dataview"]');
			mac.fs.set(".obsidian/plugins/dataview/main.js", "code");
			mac.fs.set(".obsidian/plugins/dataview/data.json", '{"x":1}');
			mac.fs.set(".obsidian/plugins/roost-sync/data.json", '{"password":"secret"}');
			mac.fs.set(".obsidian/workspace.json", "{}");
		}
		await mac.engine.initServer();
		const phone = device(server.url, folder, "phone", { config });
		await phone.engine.sync();
		return { mac, phone };
	}

	it("renaming a folder of 20 notes moves them on the server and on other devices, without a preview", async () => {
		const { mac, phone } = await setup();
		for (let i = 0; i < 20; i++) {
			mac.fs.remove(`projects/${i}.md`);
			mac.fs.set(`archive/2026/${i}.md`, `note ${i}`);
		}
		const r = await mac.engine.sync();
		expect(r.summary).toMatchObject({ move: 20, push: 0, deleteRemote: 0 });
		expect(mac.ui.reviews).toHaveLength(0);
		expect(existsSync(disk("archive/2026/7.md"))).toBe(true);
		expect(existsSync(disk("projects"))).toBe(false); // emptied folder removed
		const r2 = await phone.engine.sync();
		expect(r2.summary).toMatchObject({ move: 20, pull: 0, deleteLocal: 0 });
		expect(phone.ui.reviews).toHaveLength(0);
		expect(phone.fs.text("archive/2026/7.md")).toBe("note 7");
		expect(phone.fs.text("projects/7.md")).toBeUndefined();
		expect(phone.fs.trashed).toEqual([]);
	});

	it("agent renaming a folder on the server is detected by ETag, without downloading", async () => {
		const { mac, phone } = await setup();
		renameSync(disk("projects"), disk("done"));
		const r = await phone.engine.sync();
		expect(r.serverChanges.moved).toHaveLength(20);
		expect(r.serverChanges.created).toEqual([]);
		expect(r.serverChanges.deleted).toEqual([]);
		expect(r.summary).toMatchObject({ move: 20, pull: 0 });
		expect(phone.fs.text("done/3.md")).toBe("note 3");
		await mac.engine.sync();
		expect(mac.fs.text("done/3.md")).toBe("note 3");
		expect(mac.fs.text("projects/3.md")).toBeUndefined();
	});

	it("config folder: plugins and settings sync; workspace and Roost Sync's own folder never do", async () => {
		const { phone } = await setup(true);
		expect(phone.fs.text(".obsidian/app.json")).toBe('{"a":1}');
		expect(phone.fs.text(".obsidian/plugins/dataview/main.js")).toBe("code");
		expect(phone.fs.text(".obsidian/plugins/dataview/data.json")).toBe('{"x":1}');
		expect(phone.fs.text(".obsidian/plugins/roost-sync/data.json")).toBeUndefined();
		expect(phone.fs.text(".obsidian/workspace.json")).toBeUndefined();
		expect(existsSync(disk(".obsidian/plugins/roost-sync"))).toBe(false);
	});

	it("config conflict is resolved automatically: newer wins, older archived", async () => {
		const { mac, phone } = await setup(true);
		mac.fs.set(".obsidian/app.json", '{"a":"mac"}');
		await mac.engine.sync();
		phone.fs.set(".obsidian/app.json", '{"a":"phone, edited later"}');
		const r = await phone.engine.sync();
		expect(r.conflicts).toEqual([]);
		expect(r.actions.find((a) => a.path === ".obsidian/app.json")).toMatchObject({ kind: "push", autoResolved: true });
		await mac.engine.sync();
		expect(mac.fs.text(".obsidian/app.json")).toBe('{"a":"phone, edited later"}');
		const archived = await phone.dav.walk(".sync/conflicts");
		expect(archived.some((e) => e.path.endsWith(".obsidian/app.json"))).toBe(true);
	});

	it("uninstalling a plugin on one device removes it elsewhere", async () => {
		const { mac, phone } = await setup(true);
		mac.fs.remove(".obsidian/plugins/dataview/main.js");
		mac.fs.remove(".obsidian/plugins/dataview/data.json");
		mac.fs.set(".obsidian/community-plugins.json", "[]");
		await mac.engine.sync();
		await phone.engine.sync();
		expect(phone.fs.text(".obsidian/plugins/dataview/main.js")).toBeUndefined();
		expect(phone.fs.text(".obsidian/community-plugins.json")).toBe("[]");
	});
});

describe.skipIf(!hasUvx)("first sync on an empty server", () => {
	it("two devices setting up at once: exactly one wins, the other can then just sync", async () => {
		const server = await startWsgiDav();
		try {
			const folder = `vault-${randomId().slice(0, 8)}`;
			const a = device(server.url, folder, "a");
			const b = device(server.url, folder, "b");
			a.fs.set("a.md", "A");
			b.fs.set("b.md", "B");
			const results = await Promise.allSettled([a.engine.initServer(), b.engine.initServer()]);
			const ok = results.filter((r) => r.status === "fulfilled");
			expect(ok).toHaveLength(1);
			const loser = results[0].status === "fulfilled" ? b : a;
			const winner = loser === a ? b : a;
			loser.ui.answer = () => ({});
			await loser.engine.sync();
			await winner.engine.sync();
			expect(a.fs.text("a.md")).toBe("A");
			expect(a.fs.text("b.md")).toBe("B");
			expect(b.fs.text("a.md")).toBe("A");
		} finally {
			server.stop();
		}
	}, 120_000);
});
