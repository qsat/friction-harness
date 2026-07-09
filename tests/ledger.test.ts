import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readLedger, appendLedger } from "../lib/ledger.ts";
import { tmpDir } from "./helpers.ts";

describe("ledger", () => {
  it("存在しないファイルは空の写像", () => {
    expect(readLedger(join(tmpDir("ledger"), "none.jsonl")).size).toBe(0);
  });

  it("追記専用・session_id ごとに最終行が有効カーソル", () => {
    const path = join(tmpDir("ledger"), "ledger.jsonl");
    appendLedger(path, { session_id: "s1", transcript_path: "/t1", processed_lines: 10, last_run: "r1" });
    appendLedger(path, { session_id: "s2", transcript_path: "/t2", processed_lines: 5, last_run: "r2" });
    appendLedger(path, { session_id: "s1", transcript_path: "/t1", processed_lines: 42, last_run: "r3" });
    const m = readLedger(path);
    expect(m.get("s1")?.processed_lines).toBe(42); // 最終行が勝つ
    expect(m.get("s2")?.processed_lines).toBe(5);
  });
});
