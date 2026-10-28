/** Explicit local folder selection. The project grants no filesystem permission. */
export interface LocalProject {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  /** Removed sidebar group; existing conversations and queued work retain their folder. */
  ungrouped?: boolean;
  /** Native ChatGPT Project used only for new chats in this local project. */
  chatgpt?: ChatgptProjectLink;
}

export type ChatgptProjectLink =
  | { state: 'requested'; requestId: string; updatedAt: number }
  | { state: 'claimed'; requestId: string; owner: string; updatedAt: number }
  | { state: 'creating'; requestId: string; owner: string; updatedAt: number }
  | { state: 'linked'; id: string; updatedAt: number }
  | { state: 'failed'; requestId: string; error: string; updatedAt: number }
  | { state: 'uncertain'; requestId: string; error: string; updatedAt: number };

/** Exact provider identity accepted for a native ChatGPT Project. */
export const CHATGPT_PROJECT_ID = /^g-p-[0-9a-f]{32}$/;
