import { L as say } from "../i18n";
import type {
	Action,
	AskDecision,
	BaseEntry,
	ConflictResolution,
	FileMeta,
	Manifest,
} from "./types";

export interface PlanInput {
	/** Local files keyed by NFC path. Excludes ignored and skipped paths. */
	local: Record<string, FileMeta>;
	base: Record<string, BaseEntry>;
	manifest: Manifest;
	/** New device, lost state or long-inactive device: never push local-only files silently. */
	joinMode: boolean;
	/** Paths to leave untouched this run (ignored, oversized, invalid names, case collisions). */
	skip: (path: string) => boolean;
	decisions?: Record<string, AskDecision>;
	resolutions?: Record<string, ConflictResolution>;
	/**
	 * Config files (.obsidian): conflicts are resolved automatically (newer wins; server
	 * wins without history) and join-mode local-only files default to "delete here".
	 */
	isConfig?: (path: string) => boolean;
	/** Pair deletions and additions with the same content into moves (§5.7). Default true. */
	detectMoves?: boolean;
}

/** Decision table, design doc §5.4. Pure: no I/O. */
export function planSync(input: PlanInput): Action[] {
	const { local, base, manifest, joinMode, skip } = input;
	const isConfig = input.isConfig ?? (() => false);
	const decisions = input.decisions ?? {};
	const resolutions = input.resolutions ?? {};
	const files = manifest.files;
	const tombs = manifest.tombstones;

	const paths = new Set<string>([
		...Object.keys(local),
		...Object.keys(base),
		...Object.keys(files),
		...Object.keys(tombs),
	]);

	const actions: Action[] = [];
	const push = (a: Action | null) => a && actions.push(a);
	for (const path of [...paths].sort()) {
		if (skip(path)) continue;
		const L = local[path];
		const B = base[path];
		const R = files[path];
		const T = R ? undefined : tombs[path];
		const ctx = { path, local: L, base: B, remote: R, tomb: T };
		/** Config files never wait for the user: keep the newer one, archive the other. */
		const conflict = (reason: string): Action => {
			if (!isConfig(path) || !L || !R) return { ...ctx, kind: "conflict", reason };
			const keepLocal = !!B && L.mtime > R.mtime;
			return keepLocal
				? { ...ctx, kind: "push", reason: say("config conflict: this device is newer", "配置冲突：本机较新，保留本机"), archive: "remote", autoResolved: true }
				: {
						...ctx,
						kind: "pull",
						reason: B
							? say("config conflict: server is newer", "配置冲突：服务器较新，保留服务器")
							: say("config conflict without history: server kept", "配置冲突（无同步记录）：保留服务器"),
						archive: "local",
						autoResolved: true,
					};
		};

		const res = resolutions[path];
		if (L && R && res && res.remoteHash === R.hash && L.hash !== R.hash) {
			actions.push(
				res.choice === "local"
					? { ...ctx, kind: "push", reason: say("conflict resolved: keep this device", "冲突已处理：保留本机"), archive: "remote" }
					: { ...ctx, kind: "pull", reason: say("conflict resolved: keep server", "冲突已处理：保留服务器"), archive: "local" },
			);
			continue;
		}

		const ask = (kind: Action["ask"], reason: string, def: AskDecision["choice"]): Action | null => {
			const d = decisions[path];
			if (L && d && d.hash === L.hash) {
				if (d.choice === "push") return { ...ctx, kind: "push", reason: `${reason} → ${say("keep", "保留")}`, resurrect: !!T || kind === "resurrect", isNew: !R && !T && !B };
				if (d.choice === "deleteLocal") return { ...ctx, kind: "deleteLocal", reason: `${reason} → ${say("delete", "删除")}` };
				return null; // "skip": leave both sides alone this run
			}
			return { ...ctx, kind: "ask", ask: kind, reason, defaultChoice: def };
		};

		if (B) {
			const l = !L ? "deleted" : L.hash === B.hash ? "same" : "changed";
			const r = !R ? "deleted" : R.hash === B.hash ? "same" : "changed";
			switch (`${l}/${r}`) {
				case "same/same":
					if (R!.rev !== B.rev) actions.push({ ...ctx, kind: "markSynced", reason: say("unchanged", "未变") });
					break;
				case "same/changed":
					actions.push({ ...ctx, kind: "pull", reason: say("changed on server", "服务器上有修改") });
					break;
				case "same/deleted":
					actions.push({ ...ctx, kind: "deleteLocal", reason: say("deleted on server", "服务器上已删除") });
					break;
				case "changed/same":
					actions.push({ ...ctx, kind: "push", reason: say("changed here", "本机有修改") });
					break;
				case "changed/changed":
					actions.push(
						L!.hash === R!.hash
							? { ...ctx, kind: "markSynced", reason: say("same change on both sides", "两边改成了相同内容") }
							: conflict(say("changed on both sides", "两边都改了")),
					);
					break;
				case "changed/deleted":
					push(ask("resurrect", say("changed here but deleted on server", "本机改了，服务器上已删除"), "push"));
					break;
				case "deleted/same":
					actions.push({ ...ctx, kind: "deleteRemote", reason: say("deleted here", "本机已删除") });
					break;
				case "deleted/changed":
					actions.push({ ...ctx, kind: "pull", reason: say("deleted here but changed on server", "本机删了，服务器上有修改") });
					break;
				case "deleted/deleted":
					actions.push({ ...ctx, kind: "dropBase", reason: say("deleted on both sides", "两边都已删除") });
					break;
			}
			continue;
		}

		// No base: new device, lost state, or a path this device has never synced.
		if (L && R) {
			actions.push(
				L.hash === R.hash
					? { ...ctx, kind: "markSynced", reason: say("identical on both sides", "两边内容相同") }
					: conflict(say("differs from server and no sync history", "和服务器不同，且没有同步记录")),
			);
		} else if (L && T) {
			if (T.hash !== null && T.hash === L.hash) {
				actions.push({ ...ctx, kind: "deleteLocal", reason: say("deleted on another device (stale copy)", "其他设备已删除（本机是旧副本）") });
			} else {
				push(ask("tombstoneDiffers", say("deleted on server, local copy differs", "服务器上已删除，本机这份内容不同"), "deleteLocal"));
			}
		} else if (L) {
			if (joinMode) push(ask("joinLocalOnly", say("only on this device (join mode)", "只在本机存在（加入模式）"), isConfig(path) ? "deleteLocal" : "push"));
			else actions.push({ ...ctx, kind: "push", reason: say("new here", "本机新建"), isNew: true });
		} else if (R) {
			actions.push({ ...ctx, kind: "pull", reason: say("new on server", "服务器上新建") });
		}
	}
	return input.detectMoves === false ? actions : pairMoves(actions);
}

/**
 * Rename detection (§5.7): a deletion and an addition with identical content in the same
 * run become one move, so a renamed folder neither re-transfers files nor trips the
 * threshold guard. Case-only renames are left as delete + add (safe on case-insensitive
 * file systems, where moving `a.md` onto `A.md` would hit the same file).
 */
export function pairMoves(actions: Action[]): Action[] {
	const out = [...actions];
	const take = (from: Action[], to: Action[], make: (del: Action, add: Action) => Action) => {
		const byHash = new Map<string, Action[]>();
		for (const d of from) {
			const h = d.kind === "deleteRemote" ? (d.remote?.hash ?? d.base?.hash) : d.local?.hash;
			if (!h) continue;
			const list = byHash.get(h);
			if (list) list.push(d);
			else byHash.set(h, [d]);
		}
		for (const add of to) {
			const h = add.kind === "push" ? add.local?.hash : add.remote?.hash;
			const cands = (h ? byHash.get(h) : undefined)?.filter((d) => d.path.toLowerCase() !== add.path.toLowerCase());
			if (!cands?.length) continue;
			const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
			const del = cands.find((d) => name(d.path) === name(add.path)) ?? cands[0];
			byHash.get(h!)!.splice(byHash.get(h!)!.indexOf(del), 1);
			out.splice(out.indexOf(del), 1);
			out.splice(out.indexOf(add), 1, make(del, add));
		}
	};
	// This device renamed: delete old on server + upload new → move on the server.
	take(
		out.filter((a) => a.kind === "deleteRemote"),
		out.filter((a) => a.kind === "push" && a.isNew && a.local),
		(del, add) => ({
			path: add.path,
			from: del.path,
			kind: "moveRemote",
			reason: say(`moved here from ${del.path}`, `本机从 ${del.path} 移动而来`),
			local: add.local,
			remote: del.remote,
			base: del.base,
		}),
	);
	// Renamed elsewhere: delete old here + download new → move locally.
	take(
		out.filter((a) => a.kind === "deleteLocal" && a.local),
		out.filter((a) => a.kind === "pull" && !a.local && !a.archive && a.remote),
		(del, add) => ({
			path: add.path,
			from: del.path,
			kind: "moveLocal",
			reason: say(`moved on server from ${del.path}`, `服务器上从 ${del.path} 移动而来`),
			local: del.local,
			remote: add.remote,
			base: del.base,
		}),
	);
	return out;
}

export interface PlanSummary {
	push: number;
	pushNew: number;
	pull: number;
	deleteLocal: number;
	deleteRemote: number;
	resurrect: number;
	conflict: number;
	ask: number;
	markSynced: number;
	/** Renames/moves (not counted as risky). */
	move: number;
	/** Deletions + resurrections + new pushes: what the threshold guard counts. */
	risky: number;
}

export function summarize(actions: Action[]): PlanSummary {
	const s: PlanSummary = { push: 0, pushNew: 0, pull: 0, deleteLocal: 0, deleteRemote: 0, resurrect: 0, conflict: 0, ask: 0, markSynced: 0, move: 0, risky: 0 };
	for (const a of actions) {
		switch (a.kind) {
			case "push":
				s.push++;
				if (a.isNew) s.pushNew++;
				if (a.resurrect) s.resurrect++;
				break;
			case "pull": s.pull++; break;
			case "deleteLocal": s.deleteLocal++; break;
			case "deleteRemote": s.deleteRemote++; break;
			case "conflict": s.conflict++; break;
			case "ask": s.ask++; break;
			case "markSynced": s.markSynced++; break;
			case "moveRemote":
			case "moveLocal": s.move++; break;
		}
	}
	s.risky = s.deleteLocal + s.deleteRemote + s.resurrect + s.pushNew;
	return s;
}

/** True when the plan must be shown to the user before running (§3.5). */
export function needsPreview(
	actions: Action[],
	totalFiles: number,
	thresholdPercent: number,
	thresholdMin: number,
): boolean {
	const s = summarize(actions);
	if (s.ask > 0 || s.resurrect > 0) return true;
	if (s.risky <= thresholdMin) return false;
	return (s.risky / Math.max(totalFiles, 1)) * 100 > thresholdPercent;
}
