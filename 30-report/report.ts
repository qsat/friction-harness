/**
 * 集計・導出ビュー（spec §5.6）。alias 解決と状態導出は**ここでのみ**行う。
 * issues.jsonl / invocations.jsonl / resolutions.jsonl は一切書き換えない
 * （spec §2-1 不変ログ + 読み取り時写像、§2-5 導出ビュー）。
 *
 * 使い方: bun 30-report/report.ts [--project-id <id>] [--data-dir <dir>] [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { projectId } from "../lib/project-id.ts";

const HARNESS_ROOT = join(import.meta.dir, "..");
const VERIFY_THRESHOLD = 5; // 改訂後 N 回発動して再発ゼロ → verified（spec §5.6）

const args = process.argv.slice(2);
function argValue(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const pid = argValue("--project-id") ?? projectId(process.cwd());
const dataDir = argValue("--data-dir") ?? join(homedir(), ".claude", "friction-data", pid);
const taxonomyDir = argValue("--taxonomy-dir") ?? join(HARNESS_ROOT, "taxonomy");
const asJson = args.includes("--json");

interface Invocation {
  ts: string;
  session_id: string;
  skill_slug: string;
  skill_content_hash: string | null;
}
interface Issue {
  id: string;
  session_id: string;
  skill_slug: string;
  issue_type: string;
  issue_type_candidate: string | null;
  severity: string;
  extracted_at: string;
}
interface Resolution {
  id: string;
  group_key: string;
  issue_ids: string[];
  action: string;
  skill_content_hash_after: string | null;
  resolved_at: string;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const row of readFileSync(path, "utf8").split("\n")) {
    if (row.trim() === "") continue;
    try {
      out.push(JSON.parse(row) as T);
    } catch {
      /* ignore broken line */
    }
  }
  return out;
}

/** aliases.yaml を読み、from → to の写像（推移閉包）を返す */
function loadAliases(): Map<string, string> {
  const path = join(taxonomyDir, "aliases.yaml");
  const raw = existsSync(path) ? parseYaml(readFileSync(path, "utf8")) : [];
  const map = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (e && typeof e.from === "string" && typeof e.to === "string") map.set(e.from, e.to);
    }
  }
  return map;
}

/** alias 解決（連鎖 a→b→c にも対応。循環は打ち切り） */
function resolveType(type: string, aliases: Map<string, string>): string {
  let cur = type;
  const seen = new Set<string>();
  while (aliases.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = aliases.get(cur)!;
  }
  return cur;
}

const invocations = readJsonl<Invocation>(join(dataDir, "invocations.jsonl"));
const issuesRaw = readJsonl<Issue>(join(dataDir, "issues.jsonl"));
const resolutions = readJsonl<Resolution>(join(dataDir, "resolutions.jsonl"));
const aliases = loadAliases();

// --- alias 解決（読み取り時写像。other + candidate は candidate 側を解決対象にする） ---
const issues = issuesRaw.map((i) => {
  const effective =
    i.issue_type === "other" && i.issue_type_candidate
      ? resolveType(i.issue_type_candidate, aliases)
      : resolveType(i.issue_type, aliases);
  return { ...i, effective_type: effective };
});

// --- 導出: open issues = issues − resolutions（spec §2-5） ---
const resolvedIds = new Set(resolutions.flatMap((r) => r.issue_ids));
const openIssues = issues.filter((i) => !resolvedIds.has(i.id));

// --- クロス集計 issue_type × skill_slug ---
const cross = new Map<string, Map<string, number>>();
for (const i of issues) {
  if (!cross.has(i.effective_type)) cross.set(i.effective_type, new Map());
  const m = cross.get(i.effective_type)!;
  m.set(i.skill_slug, (m.get(i.skill_slug) ?? 0) + 1);
}

// --- other 率（taxonomy v1 凍結の判断材料） ---
// alias で正規 type に解決済みの candidate は other に数えない。
// candidate のまま（未昇格 = taxonomy に無い type）のものは other 扱いで数える。
const taxonomyTypes = new Set<string>(
  (parseYaml(readFileSync(join(taxonomyDir, "taxonomy.yaml"), "utf8")).types as { slug: string }[]).map(
    (t) => t.slug,
  ),
);
const otherCount = issues.filter(
  (i) => i.effective_type === "other" || !taxonomyTypes.has(i.effective_type),
).length;
const otherRate = issues.length > 0 ? otherCount / issues.length : 0;

// --- candidate 上位 ---
const candidateFreq = new Map<string, number>();
for (const i of issues) {
  if (i.issue_type === "other" && i.issue_type_candidate) {
    const c = resolveType(i.issue_type_candidate, aliases);
    if (!taxonomyTypes.has(c)) candidateFreq.set(c, (candidateFreq.get(c) ?? 0) + 1);
  }
}

// --- 健全率: 発動あり・issue ゼロのセッション×スキル ---
const invPairs = new Set(invocations.map((v) => `${v.session_id}/${v.skill_slug}`));
const issuePairs = new Set(issues.map((i) => `${i.session_id}/${i.skill_slug}`));
const healthyPairs = [...invPairs].filter((p) => !issuePairs.has(p));

// --- 改訂候補: 同一 group_key 3 件以上、または severity high 1 件（spec §5.6） ---
const openByGroup = new Map<string, typeof openIssues>();
for (const i of openIssues) {
  const key = `${i.skill_slug}/${i.effective_type}`;
  if (!openByGroup.has(key)) openByGroup.set(key, []);
  openByGroup.get(key)!.push(i);
}
// reopened になったグループは閾値に関わらず再び改訂候補に戻る（spec §5.8-4）。
// verification は後段で計算されるため、ここでは group_key の集合だけ先に導出する。
const reopenedGroups = new Set(
  resolutions
    .filter((r) => r.action !== "wontfix" && r.skill_content_hash_after)
    .filter((r) => {
      const skill = r.group_key.split("/")[0];
      const groupType = r.group_key.split("/").slice(1).join("/");
      const sessionsAfter = new Set(
        invocations
          .filter((v) => v.skill_slug === skill && v.skill_content_hash === r.skill_content_hash_after)
          .map((v) => v.session_id),
      );
      return issues.some(
        (i) =>
          i.skill_slug === skill &&
          i.effective_type === groupType &&
          sessionsAfter.has(i.session_id) &&
          !r.issue_ids.includes(i.id),
      );
    })
    .map((r) => r.group_key),
);
const revisionCandidates = [...openByGroup.entries()].filter(
  ([key, list]) =>
    list.length >= 3 || list.some((i) => i.severity === "high") || reopenedGroups.has(key),
);

// --- 修正検証: 改訂後ハッシュでの発動を分母に、同一 group_key の新規 issue を突合（spec §5.6） ---
const issueById = new Map(issues.map((i) => [i.id, i]));
const verification = resolutions
  .filter((r) => r.action !== "wontfix" && r.skill_content_hash_after)
  .map((r) => {
    const skill = r.group_key.split("/")[0];
    const groupType = r.group_key.split("/").slice(1).join("/");
    const invocationsAfter = invocations.filter(
      (v) => v.skill_slug === skill && v.skill_content_hash === r.skill_content_hash_after,
    );
    const sessionsAfter = new Set(invocationsAfter.map((v) => v.session_id));
    const recurrences = issues.filter(
      (i) =>
        i.skill_slug === skill &&
        i.effective_type === groupType &&
        sessionsAfter.has(i.session_id) &&
        !r.issue_ids.includes(i.id),
    );
    const status =
      recurrences.length > 0
        ? "reopened"
        : invocationsAfter.length >= VERIFY_THRESHOLD
          ? "verified"
          : `resolved (verifying ${invocationsAfter.length}/${VERIFY_THRESHOLD})`;
    return { group_key: r.group_key, resolution_id: r.id, status, invocations_after: invocationsAfter.length, recurrences: recurrences.length };
  });

const report = {
  project_id: pid,
  data_dir: dataDir,
  totals: {
    invocations: invocations.length,
    issues: issues.length,
    open_issues: openIssues.length,
    resolutions: resolutions.length,
  },
  cross_tab: Object.fromEntries([...cross.entries()].map(([t, m]) => [t, Object.fromEntries(m)])),
  other_rate: Number(otherRate.toFixed(3)),
  top_candidates: [...candidateFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  healthy_rate:
    invPairs.size > 0 ? Number((healthyPairs.length / invPairs.size).toFixed(3)) : null,
  revision_candidates: revisionCandidates.map(([key, list]) => ({
    group_key: key,
    open_count: list.length,
    max_severity: list.some((i) => i.severity === "high") ? "high" : list.some((i) => i.severity === "mid") ? "mid" : "low",
    issue_ids: list.map((i) => i.id),
  })),
  verification,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# friction report (project ${pid})`);
  console.log(`invocations=${report.totals.invocations} issues=${report.totals.issues} open=${report.totals.open_issues} resolutions=${report.totals.resolutions}`);
  console.log(`other_rate=${report.other_rate} (v1 凍結条件: < 0.20)  healthy_rate=${report.healthy_rate}`);
  console.log(`\n## issue_type × skill`);
  for (const [t, m] of Object.entries(report.cross_tab)) {
    for (const [s, n] of Object.entries(m)) console.log(`  ${t}  ${s}  ${n}`);
  }
  console.log(`\n## 改訂候補 (open ≥3 or high ≥1)`);
  for (const rc of report.revision_candidates)
    console.log(`  ${rc.group_key}  open=${rc.open_count} max_severity=${rc.max_severity}`);
  if (report.top_candidates.length > 0) {
    console.log(`\n## candidate 上位`);
    for (const [c, n] of report.top_candidates) console.log(`  ${c}  ${n}`);
  }
  if (report.verification.length > 0) {
    console.log(`\n## 修正検証`);
    for (const v of report.verification)
      console.log(`  ${v.group_key}  ${v.status} (after=${v.invocations_after}, recur=${v.recurrences})`);
  }
}
