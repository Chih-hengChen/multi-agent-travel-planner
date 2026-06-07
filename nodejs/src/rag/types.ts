export interface RagDocument {
  id: string;
  content: string;
  metadata: {
    city: string;
    source: string;
    category: string;
    title: string;
    url?: string;
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
