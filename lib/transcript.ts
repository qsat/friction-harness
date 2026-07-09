/**
 * 転写 JSONL のパースとアンカー解決（spec §5.4、実測スキーマは §6）。
 * 行は uuid/parentUuid 連鎖。uuid を持たない行 type（queue-operation, ai-title,
 * last-prompt 等）や未知 type はスキップする。
 */
import { createHash } from "node:crypto";

export interface TranscriptLine {
  /** 0-based 行番号（ledger のカーソルは行数 = この値 + 1） */
  lineNo: number;
  type: string;
  uuid: string | null;
  parentUuid: string | null;
  isSidechain: boolean | null;
  timestamp: string | null;
  raw: Record<string, unknown>;
}

export interface ToolUseBlock {
  /** tool_use ブロックを含む assistant 行 */
  line: TranscriptLine;
  toolUseId: string;
  toolName: string;
  input: unknown;
}

export function parseTranscript(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].trim();
    if (row === "") continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(row);
    } catch {
      continue; // 壊れた行は無視（追記途中の末尾行など）
    }
    lines.push({
      lineNo: i,
      type: typeof d.type === "string" ? d.type : "unknown",
      uuid: typeof d.uuid === "string" ? d.uuid : null,
      parentUuid: typeof d.parentUuid === "string" ? d.parentUuid : null,
      isSidechain: typeof d.isSidechain === "boolean" ? d.isSidechain : null,
      timestamp: typeof d.timestamp === "string" ? d.timestamp : null,
      raw: d,
    });
  }
  return lines;
}

/** assistant 行から tool_use ブロックを列挙する */
export function toolUseBlocks(lines: TranscriptLine[]): ToolUseBlock[] {
  const blocks: ToolUseBlock[] = [];
  for (const line of lines) {
    if (line.type !== "assistant" || line.uuid === null) continue;
    const message = line.raw.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && typeof b === "object" && (b as any).type === "tool_use") {
        blocks.push({
          line,
          toolUseId: String((b as any).id ?? ""),
          toolName: String((b as any).name ?? ""),
          input: (b as any).input,
        });
      }
    }
  }
  return blocks;
}

/**
 * tool_input の正規化 JSON の SHA-256（"sha256:<hex>" 形式）。
 * 正規化 = キーを再帰的にソートした compact JSON。
 * 記録側（10-collect/log-skill-use.ts）と解決側（evaluate）の両方がこの関数を使う。
 */
export function inputHash(input: unknown): string {
  const canon = canonicalJson(input);
  return "sha256:" + createHash("sha256").update(canon).digest("hex");
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v as object).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJson((v as any)[k]))
      .join(",") +
    "}"
  );
}

/**
 * invocation のアンカー解決: tool_use_id 一致を優先し、null の場合は
 * tool 名 + input_hash の一致する直近の tool_use ブロックへフォールバック（spec §5.4）。
 */
export function resolveAnchor(
  blocks: ToolUseBlock[],
  inv: { tool_use_id: string | null; input_hash: string },
): ToolUseBlock | null {
  if (inv.tool_use_id) {
    const hit = blocks.find((b) => b.toolUseId === inv.tool_use_id);
    if (hit) return hit;
  }
  // 直近一致 = 転写内で最後に現れた一致ブロック
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.toolName === "Skill" && inputHash(b.input) === inv.input_hash) {
      return b;
    }
  }
  return null;
}
