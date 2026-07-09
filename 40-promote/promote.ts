/**
 * candidate クラスタリング → 昇格提案（spec §5.7）。
 *
 * `other` の candidate を集計し、出現数が閾値以上のクラスタについて LLM に
 * 昇格（新 type）/ 統合（既存 type への alias）を提案させる。
 * **提案止まり**であり、taxonomy.yaml / aliases.yaml への反映は人間が手動で行う
 * （spec §2-4 書き込み権の一方向性）。このスクリプトはいかなるファイルも書き換えない。
 *
 * 使い方: bun 40-promote/promote.ts [--project-id <id>] [--data-dir <dir>]
 *                                   [--min-count <n=5>] [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { projectId } from "../lib/project-id.ts";

const HARNESS_ROOT = join(import.meta.dir, "..");

const args = process.argv.slice(2);
function argValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const pid = argValue("--project-id") ?? projectId(process.cwd());
const dataDir = argValue("--data-dir") ?? join(homedir(), ".claude", "friction-data", pid);
const minCount = Number(argValue("--min-count") ?? 5);
const asJson = args.includes("--json");

interface Issue {
  issue_type: string;
  issue_type_candidate: string | null;
  detail: string;
}

interface Proposal {
  action: "promote" | "alias";
  slug?: string;
  description?: string;
  to?: string;
  merge_from: string[];
  rationale: string;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const row of readFileSync(path, "utf8").split("\n")) {
    if (row.trim() === "") continue;
    try {
      out.push(JSON.parse(row) as T);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function loadAliases(): Map<string, string> {
  const path = join(HARNESS_ROOT, "taxonomy", "aliases.yaml");
  const raw = existsSync(path) ? parseYaml(readFileSync(path, "utf8")) : [];
  const map = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (e && typeof e.from === "string" && typeof e.to === "string") map.set(e.from, e.to);
    }
  }
  return map;
}

const taxonomy = parseYaml(
  readFileSync(join(HARNESS_ROOT, "taxonomy", "taxonomy.yaml"), "utf8"),
) as { version: string; types: { slug: string; description: string }[] };
const taxonomySlugs = new Set(taxonomy.types.map((t) => t.slug));
const aliases = loadAliases();

// --- 未昇格 candidate の集計（alias で正規 type に解決済みのものは除外） ---
const issues = readJsonl<Issue>(join(dataDir, "issues.jsonl"));
const clusters = new Map<string, { count: number; samples: string[] }>();
for (const i of issues) {
  if (i.issue_type !== "other" || !i.issue_type_candidate) continue;
  let c = i.issue_type_candidate;
  const seen = new Set<string>();
  while (aliases.has(c) && !seen.has(c)) {
    seen.add(c);
    c = aliases.get(c)!;
  }
  if (taxonomySlugs.has(c)) continue; // 既に正規 type へ解決される candidate は昇格対象外
  const e = clusters.get(c) ?? { count: 0, samples: [] };
  e.count++;
  if (e.samples.length < 3) e.samples.push(i.detail);
  clusters.set(c, e);
}

const eligible = [...clusters.entries()].filter(([, e]) => e.count >= minCount);

if (eligible.length === 0) {
  const status = {
    eligible: [],
    message: `昇格閾値（出現数 ≥ ${minCount}）に達した candidate はない`,
    candidates: Object.fromEntries([...clusters.entries()].map(([c, e]) => [c, e.count])),
  };
  console.log(asJson ? JSON.stringify(status, null, 2) : status.message);
  process.exit(0);
}

// --- LLM への提案依頼（クラスタリングも LLM で可。ただし提案止まり） ---
const template = readFileSync(join(HARNESS_ROOT, "40-promote", "promoter.md"), "utf8");
const prompt = template
  .replace(
    "{{TAXONOMY}}",
    taxonomy.types.map((t) => `- ${t.slug}: ${t.description}`).join("\n"),
  )
  .replace(
    "{{CANDIDATES}}",
    eligible
      .map(
        ([c, e]) =>
          `- ${c} (出現 ${e.count} 回)\n${e.samples.map((s) => `  - 例: ${s}`).join("\n")}`,
      )
      .join("\n"),
  );

const res = spawnSync("claude", ["-p", "--model", "haiku"], {
  input: prompt,
  encoding: "utf8",
  timeout: 300_000,
  maxBuffer: 16 * 1024 * 1024,
});
if (res.status !== 0) {
  console.error(`claude -p failed (status=${res.status}): ${(res.stderr ?? "").slice(0, 500)}`);
  process.exit(1);
}

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
  console.error(`promoter output is not a JSON array; discarded: ${trimmed.slice(0, 200)}`);
  return [];
}

// --- バリデーション（LLM 出力は信用しない。不正提案は破棄してログに残す） ---
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const eligibleSet = new Set(eligible.map(([c]) => c));
const proposals: Proposal[] = [];
for (const r of parseArray(res.stdout ?? "")) {
  const p = r as Record<string, unknown>;
  const action = p.action;
  const mergeFrom = Array.isArray(p.merge_from) ? p.merge_from.map(String) : [];
  const reasons: string[] = [];
  if (action !== "promote" && action !== "alias") reasons.push(`unknown action: ${action}`);
  if (mergeFrom.length === 0 || !mergeFrom.every((c) => eligibleSet.has(c)))
    reasons.push(`merge_from must be non-empty subset of eligible candidates: ${mergeFrom}`);
  if (action === "promote") {
    const slug = String(p.slug ?? "");
    if (!SLUG_RE.test(slug)) reasons.push(`invalid slug: ${slug}`);
    if (taxonomySlugs.has(slug)) reasons.push(`slug collides with existing type: ${slug}`);
    if (String(p.description ?? "").trim() === "") reasons.push("empty description");
  }
  if (action === "alias" && !taxonomySlugs.has(String(p.to ?? "")))
    reasons.push(`alias target must be an existing type: ${p.to}`);
  if (reasons.length > 0) {
    console.error(`discarded proposal (${reasons.join("; ")}): ${JSON.stringify(p).slice(0, 300)}`);
    continue;
  }
  proposals.push(p as unknown as Proposal);
}

// --- 出力: 人間がレビューして手で貼るための YAML スニペット ---
const today = new Date().toISOString().slice(0, 10);
const snippets = proposals.map((p) => {
  const aliasLines = p.merge_from.map(
    (c) => `- {from: ${c}, to: ${p.action === "promote" ? p.slug : p.to}, added: ${today}}`,
  );
  return {
    proposal: p,
    taxonomy_snippet:
      p.action === "promote"
        ? `- {slug: ${p.slug}, status: provisional, since: ${taxonomy.version}, description: ${p.description}}`
        : null,
    aliases_snippet: aliasLines.join("\n"),
  };
});

if (asJson) {
  console.log(JSON.stringify({ eligible: eligible.map(([c, e]) => ({ candidate: c, count: e.count })), proposals: snippets }, null, 2));
} else {
  console.log(`# taxonomy 昇格提案（人間レビュー用。反映は手動）`);
  for (const s of snippets) {
    const p = s.proposal;
    console.log(
      `\n## ${p.action === "promote" ? `新 type: ${p.slug}` : `統合 → ${p.to}`}  (from: ${p.merge_from.join(", ")})`,
    );
    console.log(`理由: ${p.rationale}`);
    if (s.taxonomy_snippet) console.log(`taxonomy.yaml に追記:\n  ${s.taxonomy_snippet}`);
    console.log(`aliases.yaml に追記:\n${s.aliases_snippet.split("\n").map((l) => "  " + l).join("\n")}`);
  }
  if (snippets.length === 0) console.log("(有効な提案なし)");
}
