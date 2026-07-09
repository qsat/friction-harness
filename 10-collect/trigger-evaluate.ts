#!/usr/bin/env bun
/**
 * SessionEnd: evaluate をバックグラウンド起動して即 exit 0（spec §5.3）。
 * プル型突合が正であり、このフックは即時化トリガーに過ぎない。
 * 落ちても次のスキャンで拾われるため信頼性は不要。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

try {
  const input = JSON.parse(await Bun.stdin.text());
  const cwd =
    typeof input?.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const args = [join(import.meta.dir, "..", "20-evaluate", "evaluate.ts")];
  if (typeof input?.session_id === "string" && input.session_id !== "") {
    args.push("--session", input.session_id);
  }
  // evaluate は cwd から project-id を解決するため、セッションの cwd で起動する
  const child = spawn("bun", args, { cwd, detached: true, stdio: "ignore" });
  child.unref();
} catch {
  // トリガー失敗は無視（プル型突合で回収される）
}
process.exit(0);
