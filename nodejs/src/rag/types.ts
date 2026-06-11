export interface RagDocument {
  id: string;
  content: string;
  metadata: {
    city: string;
    source: string;
    category: string;
    title: string;
    url?: string;
    chunkType?: "section" | "code_block" | "table" | "paragraph";
  };
}

export interface RagSearchParams {
  city: string;
  query: string;
  category?: string;
  maxResults?: number;
}

export interface RagSearchResult {
  document: RagDocument;
  score: number;
}

export interface RagSourceStats {
  totalDocs: number;
  byCity: Record<string, number>;
  byCategory: Record<string, number>;
  bySource: Record<string, number>;
}

export interface Section {
  content: string;
  heading?: string;
  atomic?: boolean;
  lineNumber?: number;
}

export interface ChunkStrategy {
  readonly name: string;
  detectSections(text: string): Section[];
}
