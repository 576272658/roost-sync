// Same rules as Obsidian's automated plugin review (eslint-plugin-obsidianmd).
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/", "tests/", "scripts/", "*.config.*", "esbuild.config.mjs"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.*"] },
			},
		},
	},
]);
