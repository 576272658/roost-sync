import { describe, expect, it } from "vitest";
import { DEFAULT_IGNORES, IgnoreRules, caseCollisions, windowsNameProblem } from "../src/util/paths";
import { DEFAULT_CONFIG_SYNC } from "../src/sync/config";

describe("IgnoreRules", () => {
	const r = new IgnoreRules([...DEFAULT_IGNORES, "Templates/", "attachments/*.psd", "/^tmp-\\d+/"]);
	it.each([
		[".obsidian/app.json", true],
		["notes/.hidden/x.md", true],
		["notes/.DS_Store", true],
		["a/workspace.sync-conflict-20260101.json", true],
		["~$report.docx", true],
		["Templates/daily.md", true],
		["my Templates/daily.md", false],
		["attachments/a.psd", true],
		["attachments/sub/a.psd", false],
		["tmp-123/x.md", true],
		["notes/a.md", false],
		["_inbox/a.md", false],
	])("%s → %s", (p, expected) => {
		expect(r.isIgnored(p)).toBe(expected);
	});
});

describe("windowsNameProblem", () => {
	it.each([
		["notes/a.md", false],
		["notes/what?.md", true],
		["a:b.md", true],
		["dir./x.md", true],
		["CON.md", true],
		["console.md", false],
		["中文 😀.md", false],
	])("%s → problem=%s", (p, bad) => {
		expect(windowsNameProblem(p) !== null).toBe(bad);
	});
});

it("caseCollisions", () => {
	expect(caseCollisions(["A.md", "a.md", "b.md"])).toEqual([["A.md", "a.md"]]);
});

describe("config folder rules", () => {
	const r = new IgnoreRules([...DEFAULT_IGNORES, ".obsidian/plugins/secret-plugin/"], DEFAULT_CONFIG_SYNC);
	it.each([
		[".obsidian/app.json", false],
		[".obsidian/community-plugins.json", false],
		[".obsidian/daily-notes.json", false],
		[".obsidian/plugins/dataview/main.js", false],
		[".obsidian/plugins/dataview/data.json", false],
		[".obsidian/themes/Minimal/theme.css", false],
		[".obsidian/snippets/my.css", false],
		[".obsidian/workspace.json", true],
		[".obsidian/workspace-mobile.json", true],
		[".obsidian/graph.json", true],
		[".obsidian/plugins/roost-sync/data.json", true],
		[".obsidian/plugins/roost-sync/state/base.json", true],
		[".obsidian/plugins/remotely-save/data.json", true],
		[".obsidian/plugins/secret-plugin/data.json", true],
		[".obsidian/workspace.sync-conflict-1.json", true],
		[".obsidian/cache/x", true],
		[".trash/a.md", true],
		[".sync/manifest.json", true],
	])("%s → ignored=%s", (p, expected) => {
		expect(r.isIgnored(p)).toBe(expected);
	});

	it("prunes directory listings", () => {
		expect(r.isIgnoredDir(".obsidian")).toBe(false);
		expect(r.isIgnoredDir(".obsidian/plugins")).toBe(false);
		expect(r.isIgnoredDir(".obsidian/plugins/roost-sync")).toBe(true);
		expect(r.isIgnoredDir(".obsidian/plugins/secret-plugin")).toBe(true);
		expect(r.isIgnoredDir(".sync")).toBe(true);
	});

	it("config sync off ignores the whole folder", () => {
		expect(new IgnoreRules(DEFAULT_IGNORES, null).isIgnored(".obsidian/app.json")).toBe(true);
		expect(new IgnoreRules(DEFAULT_IGNORES, { ...DEFAULT_CONFIG_SYNC, enabled: false }).isIgnored(".obsidian/app.json")).toBe(true);
	});
});
