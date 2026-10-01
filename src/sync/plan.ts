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
}

/** Decision table, design doc §5.4. Pure: no I/O. */
export function planSync(input: PlanInput): Action[] {
	const { local, base, manifest, joinMode, skip } = input;
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

		const res = resolutions[path];
		if (L && R && res && res.remoteHash === R.hash && L.hash !== R.hash) {
			actions.push(
				res.choice === "local"
					? { ...ctx, kind: "push", reason: "conflict resolved: keep this device", archive: "remote" }
					: { ...ctx, kind: "pull", reason: "conflict resolved: keep server", archive: "local" },
			);
			continue;
		}

		const ask = (kind: Action["ask"], reason: string, def: AskDecision["choice"]): Action | null => {
			const d = decisions[path];
			if (L && d && d.hash === L.hash) {
				if (d.choice === "push") return { ...ctx, kind: "push", reason: `${reason} → keep`, resurrect: !!T || kind === "resurrect", isNew: !R && !T && !B };
				if (d.choice === "deleteLocal") return { ...ctx, kind: "deleteLocal", reason: `${reason} → delete` };
				return null; // "skip": leave both sides alone this run
			}
			return { ...ctx, kind: "ask", ask: kind, reason, defaultChoice: def };
		};

		if (B) {
			const l = !L ? "deleted" : L.hash === B.hash ? "same" : "changed";
			const r = !R ? "deleted" : R.hash === B.hash ? "same" : "changed";
			switch (`${l}/${r}`) {
				case "same/same":
					if (R!.rev !== B.rev) actions.push({ ...ctx, kind: "markSynced", reason: "unchanged" });
					break;
				case "same/changed":
					actions.push({ ...ctx, kind: "pull", reason: "changed on server" });
					break;
				case "same/deleted":
					actions.push({ ...ctx, kind: "deleteLocal", reason: "deleted on server" });
					break;
				case "changed/same":
					actions.push({ ...ctx, kind: "push", reason: "changed here" });
					break;
				case "changed/changed":
					actions.push(
						L!.hash === R!.hash
							? { ...ctx, kind: "markSynced", reason: "same change on both sides" }
							: { ...ctx, kind: "conflict", reason: "changed on both sides" },
					);
					break;
				case "changed/deleted":
					push(ask("resurrect", "changed here but deleted on server", "push"));
					break;
				case "deleted/same":
					actions.push({ ...ctx, kind: "deleteRemote", reason: "deleted here" });
					break;
				case "deleted/changed":
					actions.push({ ...ctx, kind: "pull", reason: "deleted here but changed on server" });
					break;
				case "deleted/deleted":
					actions.push({ ...ctx, kind: "dropBase", reason: "deleted on both sides" });
					break;
			}
			continue;
		}

		// No base: new device, lost state, or a path this device has never synced.
		if (L && R) {
			actions.push(
				L.hash === R.hash
					? { ...ctx, kind: "markSynced", reason: "identical on both sides" }
					: { ...ctx, kind: "conflict", reason: "differs from server and no sync history" },
			);
		} else if (L && T) {
			if (T.hash !== null && T.hash === L.hash) {
				actions.push({ ...ctx, kind: "deleteLocal", reason: "deleted on another device (stale copy)" });
			} else {
				push(ask("tombstoneDiffers", "deleted on server, local copy differs", "deleteLocal"));
			}
		} else if (L) {
			if (joinMode) push(ask("joinLocalOnly", "only on this device (join mode)", "push"));
			else actions.push({ ...ctx, kind: "push", reason: "new here", isNew: true });
		} else if (R) {
			actions.push({ ...ctx, kind: "pull", reason: "new on server" });
		}
	}
	return actions;
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
	/** Deletions + resurrections + new pushes: what the threshold guard counts. */
	risky: number;
}

export function summarize(actions: Action[]): PlanSummary {
	const s: PlanSummary = { push: 0, pushNew: 0, pull: 0, deleteLocal: 0, deleteRemote: 0, resurrect: 0, conflict: 0, ask: 0, markSynced: 0, risky: 0 };
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
