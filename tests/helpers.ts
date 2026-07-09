import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HARNESS_ROOT = join(import.meta.dir, "..");

export function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `friction-${prefix}-`));
}

/** フックを実プロセスとして起動する（stdin 供給・env 上書き可） */
export function runHook(
  scriptPath: string,
  stdin: string,
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync(["bun", scriptPath], {
    stdin: Buffer.from(stdin),
    env: { ...process.env, ...env },
  });
  return {
    exitCode: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

export function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** 最小の転写フィクスチャ: Skill 発動 1 回 + 摩擦発言を含む 6 行 */
export function transcriptFixture(opts: {
  sessionId: string;
  toolUseId: string;
  skill: string;
}): { lines: unknown[]; anchorUuid: string } {
  const { sessionId, toolUseId, skill } = opts;
  const base = { sessionId, isSidechain: false, timestamp: "2026-07-09T00:00:00Z" };
  const lines = [
    { type: "queue-operation", operation: "enqueue" },
    {
      ...base, type: "user", uuid: "u1", parentUuid: null,
      message: { role: "user", content: `use the ${skill} skill` },
    },
    {
      ...base, type: "assistant", uuid: "a1", parentUuid: "u1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "Skill", input: { skill } }],
      },
    },
    {
      ...base, type: "user", uuid: "u2", parentUuid: "a1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: `Launching skill: ${skill}` }],
      },
    },
    {
      ...base, type: "assistant", uuid: "a2", parentUuid: "u2",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `[skill-friction] ${skill}: 手順が曖昧` }],
      },
    },
    { type: "last-prompt" },
  ];
  return { lines, anchorUuid: "a1" };
}

/** 対象プロジェクトのフィクスチャ（allowlist + スキル実体） */
export function projectFixture(opts: {
  allowlist: string[] | null;
  skills?: Record<string, string>;
}): string {
  const dir = tmpDir("proj");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  if (opts.allowlist !== null) {
    writeFileSync(
      join(dir, ".claude", "friction-skills.yaml"),
      "skills:\n" + opts.allowlist.map((s) => `  - ${s}`).join("\n") + "\n",
    );
  }
  for (const [slug, content] of Object.entries(opts.skills ?? {})) {
    const d = join(dir, ".claude", "skills", slug);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), content);
  }
  return dir;
}
