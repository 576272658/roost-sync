/**
 * Every user-visible string is written as L(english, chinese). The language is set
 * once by the plugin (from the "Language" setting or Obsidian's display language);
 * the sync engine and tests use the same function without depending on Obsidian.
 */
let zh = false;

export type LanguageSetting = "auto" | "en" | "zh";

export function setLanguage(lang: "en" | "zh"): void {
	zh = lang === "zh";
}

export function isChinese(): boolean {
	return zh;
}

export function L(en: string, zhText: string): string {
	return zh ? zhText : en;
}
