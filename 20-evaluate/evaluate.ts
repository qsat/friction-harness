/**
 * L2: 突合バッチ本体（spec §5.4）。
 *
 * プル型突合が正: invocations.jsonl の transcript_path と
 * ~/.claude/projects/ のスキャンを ledger と突合し、未処理範囲から
 * issue を抽出する。SessionEnd フックは即時化トリガーに過ぎない。
 *
 * 使い方:
 *   bun 20-evaluate/evaluate.ts [--session <session_id>] [--project-id <id>]
 *                               [--dry-run] [--data-dir <dir>]
 *   --dry-run: LLM を呼ばず、マーカー入り転写ウィンドウを stdout に出す（Step 2 検証用）
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { projectId } from "../lib/project-id.ts";
import {
  parseTranscript,
  toolUseBlocks,
  resolveAnchor,
  type TranscriptLine,
  type ToolUseBlock,
} from "../lib/transcript.ts";
import { readLedger, appendLedger } from "../lib/ledger.ts";
import { extractIssues } from "./llm.ts";

interface Invocation {
  ts: string;
  session_id: string;
  tool_use_id: string | null;
  skill_slug: string;
  input_hash: string;
  skill_content_hash: string | null;
  transcript_path: string;
  project_id: string;
}

export interface Anchor {
  uuid: string;
  skillSlug: string;
  lineNo: number;
  isSidechain: boolean | null;
}

export interface Window {
  anchor: Anchor;
  /** 転写の行範囲 [start, end)。冪等キー (session_id, offset_range) を構成する */
  offsetRange: [number, number];
  /** マーカー入り抽出テキスト */
  text: string;
}

const args = process.argv.slice(2);
function argValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const onlySession = argValue("--session");
const dryRun = args.includes("--dry-run");

const pid = argValue("--project-id") ?? projectId(process.cwd());
const dataDir = argValue("--data-dir") ?? join(homedir(), ".claude", "friction-data", pid);
const invocationsPath = join(dataDir, "invocations.jsonl");
const issuesPath = join(dataDir, "issues.jsonl");
const ledgerPath = join(dataDir, "ledger.jsonl");

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const row of readFileSync(path, "utf8").split("\n")) {
    if (row.trim() === "") continue;
    try {
      out.push(JSON.parse(row) as T);
    } catch {
      /* 壊れた行は無視 */
    }
  }
  return out;
}

/** 転写テキストを行単位で再構成し、アンカー行の直前にマーカーを挿入した抽出ウィンドウを作る */
function buildWindows(
  lines: TranscriptLine[],
  anchors: Anchor[],
  fromLine: number,
  totalLines: number,
): Window[] {
  const sorted = [...anchors].sort((a, b) => a.lineNo - b.lineNo);
  const windows: Window[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (a.lineNo < fromLine) continue; // 処理済み範囲のアンカーはスキップ
    // 抽出ウィンドウ: アンカー → 次のスキルアンカー（または転写末尾）で近似区切り（spec §5.4）
    const end = i + 1 < sorted.length ? sorted[i + 1].lineNo : totalLines;
    const body = lines
      .filter((l) => l.lineNo >= a.lineNo && l.lineNo < end)
      .map((l) => renderLine(l))
      .filter((s) => s !== null)
      .join("\n");
    windows.push({
      anchor: a,
      offsetRange: [a.lineNo, end],
      text: `[SKILL: ${a.skillSlug} invoked, anchor=${a.uuid}]\n${body}`,
    });
  }
  return windows;
}

/** LLM 投入用に転写行を軽量テキスト化する。uuid を残し、ノイズ行は落とす */
function renderLine(l: TranscriptLine): string | null {
  if (l.uuid === null) return null;
  const msg = l.raw.message as { role?: string; content?: unknown } | undefined;
  if (!msg) return null;
  const parts: string[] = [];
  const content = msg.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const t = (b as any).type;
      if (t === "text") parts.push((b as any).text ?? "");
      else if (t === "tool_use")
        parts.push(`<tool_use name=${(b as any).name} id=${(b as any).id}>${JSON.stringify((b as any).input).slice(0, 500)}</tool_use>`);
      else if (t === "tool_result") {
        const c = (b as any).content;
        const body = typeof c === "string" ? c : JSON.stringify(c);
        parts.push(`<tool_result for=${(b as any).tool_use_id}>${String(body).slice(0, 500)}</tool_result>`);
      }
    }
  }
  const text = parts.join("\n").trim();
  if (text === "") return null;
  return `(uuid=${l.uuid} ${l.type}${l.isSidechain ? " sidechain" : ""})\n${text}`;
}

async function main() {
  const invocations = readJsonl<Invocation>(invocationsPath).filter(
    (inv) => !onlySession || inv.session_id === onlySession,
  );

  // session_id → invocations / 転写パスの集約。transcript_path が一次情報（spec §4）
  const bySession = new Map<string, Invocation[]>();
  for (const inv of invocations) {
    if (!bySession.has(inv.session_id)) bySession.set(inv.session_id, []);
    bySession.get(inv.session_id)!.push(inv);
  }

  const ledger = readLedger(ledgerPath);
  const existingKeys = new Set(
    readJsonl<{ session_id: string; offset_range: [number, number] }>(issuesPath).map(
      (i) => `${i.session_id}:${i.offset_range[0]}-${i.offset_range[1]}`,
    ),
  );

  for (const [sessionId, invs] of bySession) {
    const transcriptPath = invs[invs.length - 1].transcript_path;
    if (!existsSync(transcriptPath)) {
      console.error(`skip ${sessionId}: transcript not found (${transcriptPath})`);
      continue;
    }
    const cursor = ledger.get(sessionId)?.processed_lines ?? 0;
    const raw = readFileSync(transcriptPath, "utf8");
    const totalLines = raw.split("\n").filter((r) => r.trim() !== "").length
      ? raw.split("\n").length - (raw.endsWith("\n") ? 1 : 0)
      : 0;
    if (totalLines <= cursor) continue; // 未処理範囲なし

    const lines = parseTranscript(raw);
    const blocks = toolUseBlocks(lines);

    // アンカー解決: tool_use_id 優先、null は tool 名 + input_hash フォールバック（spec §5.4）
    const anchors: Anchor[] = [];
    for (const inv of invs) {
      const block = resolveAnchor(blocks, inv);
      if (!block) {
        console.error(`unresolved anchor: session=${sessionId} skill=${inv.skill_slug} tool_use_id=${inv.tool_use_id}`);
        continue;
      }
      if (!anchors.some((a) => a.uuid === block.line.uuid)) {
        anchors.push({
          uuid: block.line.uuid!,
          skillSlug: inv.skill_slug,
          lineNo: block.line.lineNo,
          isSidechain: block.line.isSidechain,
        });
      }
    }

    // スキル発動ゼロの範囲は LLM を呼ばずスキップ（コスト最適化）。カーソルだけ進める
    const windows = buildWindows(lines, anchors, cursor, totalLines).filter(
      (w) => !existingKeys.has(`${sessionId}:${w.offsetRange[0]}-${w.offsetRange[1]}`),
    );

    if (dryRun) {
      for (const w of windows) {
        console.log(`=== window session=${sessionId} offset_range=[${w.offsetRange}] anchor=${w.anchor.uuid} agent_type=${w.anchor.isSidechain ? "sidechain" : "main"}`);
        console.log(w.text);
      }
      continue; // dry-run では ledger を進めない
    }

    if (windows.length > 0) {
      const issues = await extractIssues(windows, sessionId, issuesPath);
      for (const issue of issues) {
        const key = `${issue.session_id}:${issue.offset_range[0]}-${issue.offset_range[1]}`;
        // 冪等キー (session_id, offset_range)（spec §4）
        if (existingKeys.has(key)) continue;
        mkdirSync(dirname(issuesPath), { recursive: true });
        appendFileSync(issuesPath, JSON.stringify(issue) + "\n");
      }
    }

    appendLedger(ledgerPath, {
      session_id: sessionId,
      transcript_path: transcriptPath,
      processed_lines: totalLines,
      last_run: new Date().toISOString(),
    });
  }
}

await main();
