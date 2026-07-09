/**
 * LLM 呼び出しと出力バリデーション（spec §5.4 手順 5-6、§5.5）。
 * LLM の仕事は「detail の生成」と「enum への分類」のみ（spec §2-2）。
 * グルーピングキー（skill_slug, anchor, offset_range）はここで決定論的に確定させる。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { Window } from "./evaluate.ts";

const HARNESS_ROOT = join(import.meta.dir, "..");
const EVALUATOR_VERSION = "v0";

export interface Issue {
  id: string;
  session_id: string;
  anchor_uuid: string;
  skill_slug: string;
  issue_type: string;
  issue_type_candidate: string | null;
  detail: string;
  severity: "low" | "mid" | "high";
  taxonomy_version: string;
  evaluator_version: string;
  offset_range: [number, number];
  extracted_at: string;
}

interface Taxonomy {
  version: string;
  types: { slug: string; description: string }[];
}

export function loadTaxonomy(): Taxonomy {
  return parseYaml(readFileSync(join(HARNESS_ROOT, "taxonomy", "taxonomy.yaml"), "utf8"));
}

/** issues.jsonl から既存 candidate を頻度順に集める（プロンプトで再利用を促す） */
function existingCandidates(issuesPath: string): string[] {
  if (!existsSync(issuesPath)) return [];
  const freq = new Map<string, number>();
  for (const row of readFileSync(issuesPath, "utf8").split("\n")) {
    if (row.trim() === "") continue;
    try {
      const c = (JSON.parse(row) as Issue).issue_type_candidate;
      if (c) freq.set(c, (freq.get(c) ?? 0) + 1);
    } catch {
      /* ignore */
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([slug]) => slug);
}

function buildPrompt(windows: Window[], issuesPath: string, taxonomy: Taxonomy): string {
  const template = readFileSync(join(HARNESS_ROOT, "20-evaluate", "evaluator.md"), "utf8");
  const types = taxonomy.types
    .map((t) => `- ${t.slug}: ${t.description}`)
    .join("\n");
  const candidates = existingCandidates(issuesPath);
  const candidateList = candidates.length > 0 ? candidates.map((c) => `- ${c}`).join("\n") : "(まだ存在しない)";
  const transcript = windows.map((w) => w.text).join("\n\n");
  return template
    .replace("{{TYPES}}", types)
    .replace("{{EXISTING_CANDIDATES}}", candidateList)
    .replace("{{TRANSCRIPT}}", transcript);
}

/** claude -p --model haiku に投入し、生の出力テキストを返す */
function callClaude(prompt: string): string {
  const res = spawnSync("claude", ["-p", "--model", "haiku"], {
    input: prompt,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`claude -p failed (status=${res.status}): ${(res.stderr ?? "").slice(0, 500)}`);
  }
  return res.stdout ?? "";
}

/** 出力パース: JSON 配列以外の混入（コードフェンス等）にも保険で対応する */
function parseArray(text: string): unknown[] {
  const trimmed = text.trim();
  try {
    const v = JSON.parse(trimmed);
    return Array.isArray(v) ? v : [];
  } catch {
    const m = trimmed.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        const v = JSON.parse(m[0]);
        return Array.isArray(v) ? v : [];
      } catch {
        /* fallthrough */
      }
    }
  }
  console.error(`evaluator output is not a JSON array; discarded: ${trimmed.slice(0, 200)}`);
  return [];
}

/** ULID（時刻順ソート可能な 26 文字 Crockford Base32）。依存を増やさない最小実装 */
function ulid(): string {
  const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ENC[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i++) rand += ENC[bytes[i] % 32];
  return time + rand;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * windows を 1 回の LLM 呼び出しで評価し、バリデーション済み Issue を返す。
 * 不正レコード（未知 issue_type、マーカー外 anchor_uuid 等）は破棄してログに残す（spec §5.4 手順 6）。
 */
export async function extractIssues(
  windows: Window[],
  sessionId: string,
  issuesPath: string,
): Promise<Issue[]> {
  if (windows.length === 0) return [];
  const taxonomy = loadTaxonomy();
  const validTypes = new Set(taxonomy.types.map((t) => t.slug));
  const anchorToWindow = new Map(windows.map((w) => [w.anchor.uuid, w]));

  const raw = parseArray(callClaude(buildPrompt(windows, issuesPath, taxonomy)));

  const issues: Issue[] = [];
  for (const r of raw) {
    const rec = r as Record<string, unknown>;
    const anchorUuid = String(rec.anchor_uuid ?? "");
    const issueType = String(rec.issue_type ?? "");
    const severity = String(rec.severity ?? "");
    const detail = String(rec.detail ?? "").trim();
    const candidateRaw = rec.issue_type_candidate;
    const candidate = candidateRaw == null ? null : String(candidateRaw);

    const window = anchorToWindow.get(anchorUuid);
    const reasons: string[] = [];
    if (!window) reasons.push(`anchor_uuid not in marker set: ${anchorUuid}`);
    if (!validTypes.has(issueType)) reasons.push(`unknown issue_type: ${issueType}`);
    if (!["low", "mid", "high"].includes(severity)) reasons.push(`invalid severity: ${severity}`);
    if (detail === "") reasons.push("empty detail");
    if (issueType === "other" && (candidate === null || !SLUG_RE.test(candidate)))
      reasons.push(`other requires slug-form candidate: ${candidate}`);
    if (issueType !== "other" && candidate !== null)
      reasons.push("candidate must be null unless issue_type is other");

    if (reasons.length > 0) {
      console.error(`discarded record (${reasons.join("; ")}): ${JSON.stringify(rec).slice(0, 300)}`);
      continue;
    }

    issues.push({
      id: `iss-${ulid()}`,
      session_id: sessionId,
      anchor_uuid: anchorUuid,
      skill_slug: window!.anchor.skillSlug,
      issue_type: issueType,
      issue_type_candidate: candidate,
      detail,
      severity: severity as Issue["severity"],
      taxonomy_version: taxonomy.version,
      evaluator_version: EVALUATOR_VERSION,
      offset_range: window!.offsetRange,
      extracted_at: new Date().toISOString(),
    });
  }
  return issues;
}
