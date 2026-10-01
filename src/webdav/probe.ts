import { WebDavClient, WebDavError } from "./client";
import { randomId } from "../util/hash";

export interface ProbeStep {
	name: string;
	ok: boolean;
	detail: string;
	/** Required for safe syncing; optional ones only degrade features. */
	required: boolean;
}

type Lang = (en: string, zh: string) => string;

/**
 * Connection test (§3.1, §5.5): checks auth, dot-folders, conditional requests,
 * 304, MOVE and Unicode file names on the real server, in a scratch folder
 * that is removed afterwards.
 */
export async function probeServer(dav: WebDavClient, L: Lang): Promise<ProbeStep[]> {
	const steps: ProbeStep[] = [];
	const add = (name: string, ok: boolean, detail = "", required = true) => steps.push({ name, ok, detail, required });
	const msg = (e: unknown) => (e instanceof WebDavError && e.status === 401 ? L("wrong username or password", "用户名或密码错误") : e instanceof Error ? e.message : String(e));

	const t0 = Date.now();
	try {
		await dav.ensureRoot();
		await dav.propfind("", 0);
		add(L("Connect and log in", "连接并登录"), true, `${Date.now() - t0} ms`);
	} catch (e) {
		add(L("Connect and log in", "连接并登录"), false, msg(e));
		return steps;
	}

	const dir = `.sync/probe-${randomId().slice(0, 8)}`;
	try {
		await dav.ensureDir(dir);
		const listed = (await dav.propfind(".sync", 1)) ?? [];
		add(L("Create and list hidden folders (.sync)", "创建并列出隐藏目录（.sync）"), listed.some((e) => e.path === dir));

		const f = `${dir}/lock-test.json`;
		const first = await dav.put(f, '{"n":1}', { ifNoneMatch: "*" });
		const second = await dav.put(f, '{"n":2}', { ifNoneMatch: "*" });
		add(L("Create-only write (If-None-Match: *)", "仅创建写入（If-None-Match: *）"), first === "ok" && second === "precondition-failed",
			second === "ok" ? L("server overwrote an existing file; the sync lock is not safe", "服务器覆盖了已存在的文件，同步锁不可靠") : "");

		const got = await dav.get(f);
		const hasEtag = !!got.etag;
		add(L("ETag on files", "文件 ETag"), hasEtag, got.etag ?? L("missing", "缺失"));
		if (hasEtag) {
			const wrong = await dav.put(f, "x", { ifMatch: "definitely-not-the-etag" });
			add(L("Conditional update (If-Match)", "条件更新（If-Match）"), wrong === "precondition-failed");
			const again = await dav.get(f, got.etag);
			add(L("Unchanged-manifest shortcut (304)", "清单未变化时免下载（304）"), again.status === 304, again.status === 304 ? "" : `HTTP ${again.status}`, false);
		}

		const uni = `${dir}/中文 😀 é/笔记 Ünï.md`;
		await dav.put(uni, "你好 😀");
		const back = await dav.getText(uni);
		const names = (await dav.propfind(`${dir}/中文 😀 é`, 1)) ?? [];
		add(L("Chinese / emoji / accented names", "中文、emoji、带声调字母的文件名"), back === "你好 😀" && names.some((e) => e.path === uni.normalize("NFC")));

		const moved = `${dir}/moved/target.md`;
		const ok = await dav.move(uni, moved);
		const src = await dav.get(uni);
		const dst = await dav.getText(moved);
		add(L("Move (used for server trash)", "移动（用于服务器回收站）"), ok && src.status === 404 && dst === "你好 😀");
	} catch (e) {
		add(L("Unexpected error", "意外错误"), false, msg(e));
	} finally {
		await dav.delete(dir, true).catch(() => {});
		add(L("Clean up test folder", "清理测试目录"), true, "", false);
	}
	return steps;
}
