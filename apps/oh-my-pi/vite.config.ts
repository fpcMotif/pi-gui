import { defineConfig } from "vite";

export default defineConfig({
	root: ".",
	build: {
		outDir: "dist",
		target: "es2022",
		emptyOutDir: true,
	},
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
	},
	envPrefix: ["VITE_", "TAURI_"],
});
