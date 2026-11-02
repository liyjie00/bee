export interface JSONMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface JSONNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JSONNode[];
  marks?: JSONMark[];
  text?: string;
}
