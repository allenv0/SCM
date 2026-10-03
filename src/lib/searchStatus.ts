/**
 * Search lifecycle state machine (L2 FP).
 *
 * Replaces four scattered useStates in useMemorySearch
 * (isReady/isSearching/error/sceneDataReady) with one pure reducer so
 * transitions are explicit, reviewable, and unit-testable:
 * - a stale index load can never clobber a fresh one into "ready"
 * - a search end can never clear a newer search's "searching" flag by accident
 * - model errors funnel through one action, not ad-hoc setters
 *
 * Models/migration/preloads stay separate useStates: different domain
 * (registry/downloads), different lifetime.
 */

export interface SearchStatusState {
	readonly isReady: boolean;
	readonly isSearching: boolean;
	readonly error: string | null;
	readonly sceneDataReady: boolean;
}

export const initialSearchStatus: SearchStatusState = {
	isReady: false,
	isSearching: false,
	error: null,
	sceneDataReady: false,
};

export type SearchStatusAction =
	| { readonly type: "index/invalidate" }
	| { readonly type: "index/ready" }
	| { readonly type: "index/error"; readonly error: string }
	| { readonly type: "search/start" }
	| { readonly type: "search/end" }
	| { readonly type: "search/error"; readonly error: string }
	| { readonly type: "scene/ready" }
	| { readonly type: "status/model-error" }
	| { readonly type: "error/clear" };

export function searchStatusReducer(
	state: SearchStatusState,
	action: SearchStatusAction,
): SearchStatusState {
	switch (action.type) {
		case "index/invalidate":
			return { ...state, isReady: false, sceneDataReady: false };
		case "index/ready":
			return { ...state, isReady: true, error: null };
		case "index/error":
			return { ...state, error: action.error };
		case "search/start":
			return { ...state, isSearching: true };
		case "search/end":
			return { ...state, isSearching: false };
		case "search/error":
			return { ...state, isSearching: false, error: action.error };
		case "scene/ready":
			return state.sceneDataReady ? state : { ...state, sceneDataReady: true };
		case "status/model-error":
			return {
				...state,
				error: "AI model failed to load; keyword search only",
			};
		case "error/clear":
			return state.error === null ? state : { ...state, error: null };
	}
}
