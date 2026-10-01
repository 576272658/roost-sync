export async function sha256(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return "sha256:" + hex;
}

export function randomId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const b = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
