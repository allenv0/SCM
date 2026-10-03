import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
	plugins: [react()],
	// Relative asset URLs so the built HTML works under app://localhost/
	base: "./",
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2020",
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
});
