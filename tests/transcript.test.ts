import { describe, expect, it } from "bun:test";
import {
  parseTranscript,
  toolUseBlocks,
  inputHash,
  resolveAnchor,
} from "../lib/transcript.ts";
import { transcriptFixture } from "./helpers.ts";

const { lines } = transcriptFixture({
  sessionId: "s1",
  toolUseId: "toolu_A",
  skill: "demo",
});
const text = lines.map((l) => JSON.stringify(l)).join("\n");

describe("parseTranscript", () => {
  it("uuid の有無に関わらず行を保持し、壊れた行・空行はスキップする", () => {
    const parsed = parseTranscript(text + "\n\nbroken{{{\n");
    expect(parsed.length).toBe(6);
    expect(parsed[0].uuid).toBeNull(); // queue-operation
    expect(parsed[1].uuid).toBe("u1");
    expect(parsed[2].isSidechain).toBe(false);
  });

  it("lineNo は元ファイルの行番号を保持する", () => {
    const parsed = parseTranscript("\n" + text);
    expect(parsed[1].lineNo).toBe(2); // 先頭空行分ずれる
  });
});

describe("toolUseBlocks", () => {
  it("assistant 行の tool_use を列挙し、アンカー行 uuid を持つ", () => {
    const blocks = toolUseBlocks(parseTranscript(text));
    expect(blocks.length).toBe(1);
    expect(blocks[0].toolUseId).toBe("toolu_A");
    expect(blocks[0].toolName).toBe("Skill");
    expect(blocks[0].line.uuid).toBe("a1");
  });
});

describe("inputHash", () => {
  it("キー順に依存しない正規化ハッシュを返す", () => {
    expect(inputHash({ a: 1, b: { d: 4, c: 3 } })).toBe(
      inputHash({ b: { c: 3, d: 4 }, a: 1 }),
    );
  });
  it("値が異なればハッシュも異なる", () => {
    expect(inputHash({ skill: "x" })).not.toBe(inputHash({ skill: "y" }));
  });
  it("sha256: プレフィックス形式", () => {
    expect(inputHash({ skill: "demo" })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("resolveAnchor", () => {
  const blocks = toolUseBlocks(parseTranscript(text));

  it("tool_use_id の一致を最優先で解決する", () => {
    const hit = resolveAnchor(blocks, {
      tool_use_id: "toolu_A",
      input_hash: "sha256:wrong",
    });
    expect(hit?.line.uuid).toBe("a1");
  });

  it("tool_use_id が null なら tool名 + input_hash でフォールバックする", () => {
    const hit = resolveAnchor(blocks, {
      tool_use_id: null,
      input_hash: inputHash({ skill: "demo" }),
    });
    expect(hit?.line.uuid).toBe("a1");
  });

  it("どちらも一致しなければ null", () => {
    const hit = resolveAnchor(blocks, {
      tool_use_id: null,
      input_hash: "sha256:nomatch",
    });
    expect(hit).toBeNull();
  });
});
