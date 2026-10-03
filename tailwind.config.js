/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ["./src/**/*.{js,ts,jsx,tsx}", "./index.html"],
	plugins: [],
	darkMode: "class",
	theme: {
		extend: {
			fontFamily: {
				sans: ["var(--font-ioskeley-mono)", "monospace"],
			},
		},
	},
};
