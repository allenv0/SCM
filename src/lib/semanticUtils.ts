import type { TextChunk, ScoredChunk } from "@/lib/embeddingIndex";

export const TEXT_WEIGHT = 0.7;
export const HEADING_WEIGHT = 0.3;
export const DIVERSITY_SIM_THRESHOLD = 0.92;

export function base64ToFloat32Array(base64: string): Float32Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new Float32Array(bytes.buffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function computeScores(
	qVec: Float32Array,
	chunks: TextChunk[],
	textEmbeddings: Float32Array[],
	headingEmbeddings?: Float32Array[] | null,
): { idx: number; chunk: TextChunk; score: number }[] {
	const hasHeadings =
		headingEmbeddings && headingEmbeddings.length === textEmbeddings.length;
	const results: { idx: number; chunk: TextChunk; score: number }[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const textScore = cosineSimilarity(qVec, textEmbeddings[i]);
		const headingScore = hasHeadings
			? cosineSimilarity(qVec, headingEmbeddings[i])
			: textScore;
		const combinedScore =
			TEXT_WEIGHT * textScore + HEADING_WEIGHT * headingScore;
		results.push({ idx: i, chunk: chunks[i], score: combinedScore });
	}

	return results;
}

export function diversityFilter<T extends { idx: number; score: number }>(
	scored: T[],
	embeddings: Float32Array[],
	topK: number,
	threshold = DIVERSITY_SIM_THRESHOLD,
	groupKey?: (idx: number) => string | null,
): T[] {
	const sorted = [...scored].sort((a, b) => b.score - a.score);
	const selected: T[] = [];

	for (const candidate of sorted) {
		if (selected.length >= topK) break;

		const candGroup = groupKey ? groupKey(candidate.idx) : null;
		let tooSimilar = false;

		for (const sel of selected) {
			// Only dedupe against candidates from the same group (e.g. the same
			// post). This preserves genuinely different adjacent sections of a
			// post instead of dropping them for the global 0.92 threshold.
			if (groupKey && candGroup !== null && groupKey(sel.idx) !== candGroup) {
				continue;
			}
			const sim = cosineSimilarity(
				embeddings[candidate.idx],
				embeddings[sel.idx],
			);
			if (sim > threshold) {
				tooSimilar = true;
				break;
			}
		}

		if (!tooSimilar) {
			selected.push(candidate);
		}
	}

	if (selected.length < 3) {
		return sorted.slice(0, topK);
	}

	return selected;
}

export function toScoredChunks<
	T extends { idx: number; chunk: TextChunk; score: number },
>(results: T[]): ScoredChunk[] {
	return results.map((t) => ({
		...t.chunk,
		score: t.score,
		semanticScore: t.score,
	}));
}
