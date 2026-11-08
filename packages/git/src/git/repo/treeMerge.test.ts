import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import git from "isomorphic-git";

import type { GitMergeDriver, GitStorageHost } from "../types";
import type { RepoContext } from "./repoContext";
import { mergeTrees, type TreeMergeState } from "./treeMerge";

let dir: string;
let ctx: RepoContext;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "git-tree-merge-"));
  ctx = {
    git: { fs, dir, gitdir: join(dir, ".git"), cache: {} },
    host: {} as GitStorageHost,
  };
  await git.init({ ...ctx.git });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const utf8 = (text: string) => new TextEncoder().encode(text);

async function treeWith(content: Uint8Array): Promise<string> {
  const oid = await git.writeBlob({ ...ctx.git, blob: content });
  return git.writeTree({
    ...ctx.git,
    tree: [{ path: "f.txt", mode: "100644", oid, type: "blob" }],
  });
}

async function merge(
  [base, ours, theirs]: Uint8Array[],
  driver?: GitMergeDriver,
) {
  const state: TreeMergeState = {
    commit: "c".repeat(40),
    holder: "theirs",
    driver,
    merged: [],
    conflicts: [],
  };
  const tree = await mergeTrees(
    ctx,
    state,
    await treeWith(base),
    await treeWith(ours),
    await treeWith(theirs),
  );
  const content = state.conflicts.length
    ? null
    : (await git.readBlob({ ...ctx.git, oid: tree!, filepath: "f.txt" })).blob;
  return { state, content };
}

describe("mergeTrees file contents", () => {
  it("never rewrites bytes: invalid UTF-8 is binary, a BOM survives", async () => {
    const latin = await merge([
      latin1("caf\xe9\nb\nc\nd\n"),
      latin1("caf\xe9\nB\nc\nd\n"),
      latin1("caf\xe9\nb\nc\nD\n"),
    ]);
    expect(latin.state.conflicts).toEqual([
      { commit: "c".repeat(40), path: "f.txt", reason: "binary" },
    ]);

    const bom = await merge([
      utf8("﻿a\nb\nc\nd\n"),
      utf8("﻿a\nB\nc\nd\n"),
      utf8("﻿a\nb\nc\nD\n"),
    ]);
    expect(bom.state.conflicts).toEqual([]);
    expect(bom.content).toEqual(utf8("﻿a\nB\nc\nD\n"));
  });

  it("a file whose text is exactly `binary` is text, and reaches the driver", async () => {
    const calls: Array<string | null> = [];
    const driver: GitMergeDriver = {
      merge({ base, ours, theirs }) {
        calls.push(base);
        return { content: `${ours}+${theirs}`, overwritten: [] };
      },
    };
    const { state, content } = await merge(
      [utf8("binary"), utf8("ours"), utf8("theirs")],
      driver,
    );
    expect(calls).toEqual(["binary"]);
    expect(state.conflicts).toEqual([]);
    expect(content).toEqual(utf8("ours+theirs"));
  });
});
