export interface TextChunk {
	id: string;
	text: string;
	source: string;
	slug: string;
	url: string;
	heading: string;
	type: string;
	metadata: Record<string, string>;
}

export interface ChunkIndex {
	chunks: TextChunk[];
	version: number;
	generatedAt: string;
}

export interface ScoredChunk extends TextChunk {
	score: number;
	semanticScore?: number;
	keywordScore?: number;
}

export type ChunkType = "post" | "movie" | "book";
