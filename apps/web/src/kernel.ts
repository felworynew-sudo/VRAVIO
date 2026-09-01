import { CommandRegistry, DocumentStore, HistoryManager, KeymapManager } from "@vravio/kernel";

export const kernel = {
  documents: new DocumentStore(),
  commands: new CommandRegistry(),
  keymap: new KeymapManager(),
  historyByDocument: new Map<string, HistoryManager>(),
  /** Original RAW file bytes kept in memory (not part of the persisted schema) so Filter > Camera Raw can re-develop a document that was opened from a RAW file. */
  rawSourceByDocument: new Map<string, { buffer: ArrayBuffer; name: string }>(),
};
