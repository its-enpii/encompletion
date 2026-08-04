export type Msg = {
  id: number;
  role: "user" | "assistant";
  content: string;
  feedback?: "like" | "dislike" | null;
  failed?: boolean;
  // Cross-session recall hits surfaced as a "sources used" badge under
  // assistant messages. JSON array of
  // {source_kind, source_id, label, score} decoded from the messages
  // row. Null/undefined when no recall was available.
  recall_hits?: RecallHit[] | null;
};

export type RecallHit = {
  source_kind: "project_knowledge" | "attachment" | "user_message" | string;
  source_id: number;
  label: string;
  score: number;
};

export type Att = {
  id: number;
  file_name: string;
  mime_type: string;
  size: number;
  url: string;
};

export type PendingAtt = {
  file_name: string;
  mime_type: string;
  size: number;
  content?: string;
  file_path: string;
};

export type Usage = {
  input: number;
  output: number;
  cost: number;
  durationMs: number;
};
