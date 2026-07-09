export type Msg = {
  id: number;
  role: "user" | "assistant";
  content: string;
  feedback?: "like" | "dislike" | null;
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