import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteRepo } from "../src/sync/remote";
import { syncSharedSettings } from "../src/sync/sharedSettings";
import { randomId } from "../src/util/hash";
import { WebDavClient } from "../src/webdav/client";
import { fetchTransport } from "../src/webdav/transport";
import { hasUvx, startWsgiDav } from "./helpers";

describe.skipIf(!hasUvx)("Roost Sync's own settings shared across devices", () => {
	let server: Awaited<ReturnType<typeof startWsgiDav>>;
	beforeAll(async () => {
		server = await startWsgiDav();
	});
	afterAll(() => server?.stop());

	const repo = async (folder: string) => {
		const dav = new WebDavClient(fetchTransport, server.url, folder);
		await dav.ensureRoot();
		return new RemoteRepo(dav, { id: randomId(), name: "x" });
	};
	const defaults = () => ({ syncAfterEditSec: 0, intervalMinutes: 0, ignorePatterns: ".DS_Store", password: "per-device" });

	it("a change on one device reaches the others; per-device values never leave the device", async () => {
		const folder = `v-${randomId().slice(0, 6)}`;
		const mac = { s: { ...defaults(), password: "mac-secret" }, t: 0 };
		const phone = { s: defaults(), t: 0 };
		const ex = async (d: typeof mac, name: string) => {
			const r = await syncSharedSettings(await repo(folder), d.s, d.t, name);
			if (r.action === "pushed") d.t = r.updatedAt;
			if (r.action === "pulled") {
				Object.assign(d.s, r.settings);
				d.t = r.updatedAt;
			}
			return r.action;
		};
		expect(await ex(mac, "mac")).toBe("pushed"); // first device: publishes (dated 0)
		expect(await ex(phone, "phone")).toBe("none");

		mac.s.syncAfterEditSec = 10;
		mac.t = Date.now();
		expect(await ex(mac, "mac")).toBe("pushed");
		expect(await ex(phone, "phone")).toBe("pulled");
		expect(phone.s.syncAfterEditSec).toBe(10);
		expect(phone.s.password).toBe("per-device");

		const raw = await (await repo(folder)).dav.getText(".sync/settings.json");
		expect(raw).not.toContain("secret");
		expect(raw).not.toContain("password");
	});

	it("an untouched device never overwrites a customized one (upgrade case)", async () => {
		const folder = `v-${randomId().slice(0, 6)}`;
		const untouched = { s: defaults(), t: 0 };
		const customized = { s: { ...defaults(), syncAfterEditSec: 10 }, t: 1_000 };
		await syncSharedSettings(await repo(folder), untouched.s, untouched.t, "phone"); // pushes, dated 0
		const r = await syncSharedSettings(await repo(folder), customized.s, customized.t, "mac");
		expect(r.action).toBe("pushed");
		const back = await syncSharedSettings(await repo(folder), untouched.s, untouched.t, "phone");
		expect(back).toMatchObject({ action: "pulled", settings: { syncAfterEditSec: 10 } });
	});
});
