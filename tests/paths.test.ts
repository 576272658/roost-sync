import { describe, expect, it } from "vitest";
import { DEFAULT_IGNORES, IgnoreRules, caseCollisions, windowsNameProblem } from "../src/util/paths";

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
