import { moment } from "obsidian";

let zh: boolean | null = null;

/** Picks the Chinese or English string according to Obsidian's display language. */
export function L(en: string, zhText: string): string {
	if (zh === null) {
		const lang = (window.localStorage.getItem("language") || moment.locale() || "en").toLowerCase();
		zh = lang.startsWith("zh");
	}
	return zh ? zhText : en;
}
