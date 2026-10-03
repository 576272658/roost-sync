import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Integration tests talk to a real WsgiDAV; CI runners are slower than a laptop.
		testTimeout: 30_000,
		hookTimeout: 180_000,
		setupFiles: ["tests/setup.ts"],
	},
});
