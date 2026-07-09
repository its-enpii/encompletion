export type Session = {
  id: number;
  project_id: number | null;
  title: string | null;
  model: string;
  updated_at: string;
  archived_at: string | null;
  total_cost_usd: number;
  total_tokens: number;
  starred?: 0 | 1 | boolean;
  owner_username?: string;
};

export type Project = {
  id: number;
  name: string;
  description: string | null;
  color: string;
  archived_at: string | null;
  session_count?: number;
};