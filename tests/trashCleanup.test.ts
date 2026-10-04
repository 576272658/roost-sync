import { describe, expect, it } from "vitest";
import { cleanVaultTrash, planTrashCleanup, type TrashAdapter } from "../src/util/trashCleanup";

const DAY = 86_400_000;

describe("planTrashCleanup", () => {
	it("counts age from first sighting, not mtime", () => {
		const r = planTrashCleanup([".trash/a.md"], {}, 100 * DAY, 30);
		expect(r.expired).toEqual([]);
		expect(r.seen).toEqual({ ".trash/a.md": 100 * DAY });
	});

	it("expires files seen long enough ago and forgets vanished ones", () => {
		const r = planTrashCleanup([".trash/old.md", ".trash/new.md"], { ".trash/old.md": 0, ".trash/new.md": 20 * DAY, ".trash/gone.md": 0 }, 30 * DAY, 30);
		expect(r.expired).toEqual([".trash/old.md"]);
		expect(r.seen).toEqual({ ".trash/new.md": 20 * DAY });
	});
});

class FakeAdapter implements TrashAdapter {
	files = new Map<string, string>();
	dirs = new Set<string>();
	async exists(p: string) {
		return this.files.has(p) || this.dirs.has(p);
	}
	async list(p: string) {
		const kids = (xs: Iterable<string>) => [...xs].filter((x) => x.startsWith(p + "/") && !x.slice(p.length + 1).includes("/"));
		return { files: kids(this.files.keys()), folders: kids(this.dirs) };
	}
	async read(p: string) {
		return this.files.get(p)!;
	}
	async write(p: string, d: string) {
		this.files.set(p, d);
	}
	async remove(p: string) {
		this.files.delete(p);
	}
	async rmdir(p: string) {
		this.dirs.delete(p);
	}
}

describe("cleanVaultTrash", () => {
	it("deletes expired files and empty folders, keeps the rest", async () => {
		const a = new FakeAdapter();
		a.dirs.add(".trash").add(".trash/Folder");
		a.files.set(".trash/Folder/x.md", "x").set(".trash/y.md", "y");
		const seen = "state/trash-seen.json";

		expect(await cleanVaultTrash(a, seen, 30, 0)).toBe(0); // first run only records
		a.files.set(".trash/z.md", "z"); // trashed later
		expect(await cleanVaultTrash(a, seen, 30, 10 * DAY)).toBe(0);
		expect(await cleanVaultTrash(a, seen, 30, 30 * DAY)).toBe(2);

		expect([...a.files.keys()].filter((f) => f.startsWith(".trash"))).toEqual([".trash/z.md"]);
		expect(a.dirs.has(".trash/Folder")).toBe(false);
		expect(a.dirs.has(".trash")).toBe(true);
		expect(await cleanVaultTrash(a, seen, 30, 40 * DAY)).toBe(1);
	});

	it("does nothing when there is no .trash", async () => {
		const a = new FakeAdapter();
		expect(await cleanVaultTrash(a, "s.json", 30, 0)).toBe(0);
	});
});
