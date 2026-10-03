// Phase 0 (N-04) lint floor: machine-checked from here on, so every later
// diff (god-file splits, virtualization) is verified, not eyeballed.
// Deliberately lean: no stylistic rules (prettier owns style), no react
// plugin (JSX style churn out of scope) — correctness rules only.

const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const reactHooks = require("eslint-plugin-react-hooks");

module.exports = [
	{
		ignores: ["node_modules/", "dist/", "dist-app/", "indexer/__pycache__/"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts", "**/*.tsx"],
		plugins: { "react-hooks": reactHooks },
		rules: {
			...reactHooks.configs.flat.recommended.rules,
			// `any` is the codebase's IPC-boundary convention
			// (catch (e: any), bridge payloads) — typed later, not here.
			"@typescript-eslint/no-explicit-any": "off",
			// 10 mount-time fetch/subscribe sites (App library load, grid
			// trays, search index) intentionally mirror external state into
			// useState — the blessed effect use-case. Revisit during the
			// M-12 grid split; until then a warning, not a gate.
			"react-hooks/set-state-in-effect": "warn",
		},
	},
	{
		files: ["**/*.js"],
		languageOptions: {
			sourceType: "commonjs",
			globals: {
				...require("globals").node,
			},
		},
		rules: {
			// CJS is this repo's module system (main.js, indexer/,
			// scripts/, node harness). ESM-only deps use dynamic import().
			"@typescript-eslint/no-require-imports": "off",
		},
	},
	{
		// Injected into the page, not node: needs window/document.
		files: ["public/**/*.js"],
		languageOptions: {
			sourceType: "script",
			globals: {
				...require("globals").browser,
			},
		},
	},
];
