// Shared choosable-row recipes (MDs/Settings-Design-System.md §5.2).
// Selection is sky — violet is reserved for the AI-process spectrum.
// Used by SettingsSheet, ModelPicker, and AskPanel so the three surfaces
// cannot silently drift apart.
export const SELECTED_ROW =
	"border-sky-500/60 bg-gradient-to-b from-white to-[#dce6f2] shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_4px_rgba(14,165,233,0.25)] dark:border-sky-400/50 dark:from-[#2b3646] dark:to-[#1d2531] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_1px_4px_rgba(0,0,0,0.5)]";

export const IDLE_ROW =
	"border-slate-500/25 bg-white/40 hover:bg-white/70 dark:border-slate-600/40 dark:bg-black/20 dark:hover:bg-white/[0.07]";
