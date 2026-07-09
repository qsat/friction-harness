/**
 * 処理カーソル台帳（spec §4 ledger.jsonl）。
 * 追記専用・session_id ごとに最終行が現在のカーソル。行数カーソル方式
 * （--resume でセッションが伸びるため processed をブール値にしない）。
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface LedgerEntry {
  session_id: string;
  transcript_path: string;
  processed_lines: number;
  last_run: string;
}

/** session_id → 有効カーソル（最終行）の写像を返す */
export function readLedger(path: string): Map<string, LedgerEntry> {
  const cursors = new Map<string, LedgerEntry>();
  if (!existsSync(path)) return cursors;
  for (const row of readFileSync(path, "utf8").split("\n")) {
    if (row.trim() === "") continue;
    try {
      const e = JSON.parse(row) as LedgerEntry;
      if (typeof e.session_id === "string") cursors.set(e.session_id, e);
    } catch {
      // 壊れた行は無視
    }
  }
  return cursors;
}

export function appendLedger(path: string, entry: LedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
