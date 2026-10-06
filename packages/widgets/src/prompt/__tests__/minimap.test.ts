/**
 * The prompt widget's minimap declarations (MET-172): entry derivation
 * (order, proportional position, the title chain) and the phase → dot
 * treatment map (core = lifecycle, motion = attention).
 */
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { Schema, Node as PMNode } from "@tiptap/pm/model";
import { deriveMinimapEntries } from "../../minimap/contract";
import { AiPromptNodeBase, PromptDraftNodeBase } from "../node";
import { promptMentionNode } from "../composer/mention-node";
import { describeDotState, promptMinimapSource } from "../minimap";
import { updatePromptBlob } from "../store";

const schema: Schema = getSchema([
  StarterKit,
  AiPromptNodeBase,
  PromptDraftNodeBase,
  promptMentionNode(),
]);

const sources = { aiPrompt: promptMinimapSource };

function widget(blobId: string, draft = ""): PMNode {
  return schema.nodes.aiPrompt.create(
    { blobId, taskId: `task_${blobId}` },
    schema.nodes.promptDraft.create(
      null,
      draft ? [schema.text(draft)] : [],
    ),
  );
}

function para(text: string): PMNode {
  return schema.nodes.paragraph.create(null, [schema.text(text)]);
}

function doc(...children: PMNode[]): PMNode {
  return schema.nodes.doc.create(null, children);
}

describe("deriveMinimapEntries", () => {
  it("maps widgets in document order with proportional, clamped ratios", () => {
    const paras = (n: number) =>
      Array.from({ length: n }, (_, i) => para(`para ${i}`));
    const d = doc(
      widget("blob_top"),
      ...paras(20),
      widget("blob_mid"),
      ...paras(20),
      widget("blob_end"),
    );
    const entries = deriveMinimapEntries(d, sources);
    expect(entries.map((e) => e.key.split(":")[1])).toEqual([
      "blob_top",
      "blob_mid",
      "blob_end",
    ]);
    expect(entries[0].ratio).toBeGreaterThanOrEqual(0.01);
    expect(entries[2].ratio).toBeLessThanOrEqual(0.99);
    expect(entries[0].ratio).toBeLessThan(entries[1].ratio);
    expect(entries[1].ratio).toBeLessThan(entries[2].ratio);
    expect(entries[1].ratio).toBeGreaterThan(0.3);
    expect(entries[1].ratio).toBeLessThan(0.7);
  });

  it("titles from draft text, then last sent prompt, then a generic label", () => {
    updatePromptBlob("blob_sent", { lastSentPrompt: "summarize the doc" });
    const d = doc(
      widget("blob_draft", "half typed"),
      para("x"),
      widget("blob_sent"),
      para("y"),
      widget("blob_blank"),
    );
    const titles = deriveMinimapEntries(d, sources).map((e) => e.title);
    expect(titles).toEqual(["half typed", "summarize the doc", "Prompt"]);
  });

  it("truncates long titles with an ellipsis", () => {
    const long = "word ".repeat(30).trim();
    const [entry] = deriveMinimapEntries(doc(widget("blob_l", long)), sources);
    expect(entry.title.length).toBeLessThanOrEqual(49);
    expect(entry.title.endsWith("…")).toBe(true);
  });

  it("gives duplicated markers (same blobId) distinct keys sharing identity", () => {
    // External edits can copy-paste a marker; parsing doesn't dedupe.
    const d = doc(widget("blob_dup"), para("between"), widget("blob_dup"));
    const entries = deriveMinimapEntries(d, sources);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.key)).size).toBe(2);
    expect(new Set(entries.map((e) => e.observerKey)).size).toBe(1);
  });

  it("spreads crowded dots to a minimum separation, preserving order", () => {
    // Three adjacent widgets at the very top of a long document would
    // otherwise land within a couple pixels of each other.
    const filler = Array.from({ length: 60 }, (_, i) => para(`filler ${i}`));
    const d = doc(
      widget("blob_a"),
      widget("blob_b"),
      widget("blob_c"),
      ...filler,
    );
    const entries = deriveMinimapEntries(d, sources);
    const ratios = entries.map((e) => e.ratio);
    expect(ratios[1] - ratios[0]).toBeGreaterThanOrEqual(0.069);
    expect(ratios[2] - ratios[1]).toBeGreaterThanOrEqual(0.069);
    // ≥ RATIO_LO up to float noise from the backward pass.
    expect(ratios[0]).toBeGreaterThanOrEqual(0.0099);
    expect(ratios[2]).toBeLessThanOrEqual(0.99);
  });

  it("compresses the gap instead of overflowing when the rail is full", () => {
    const many = Array.from({ length: 30 }, (_, i) => widget(`blob_m${i}`));
    const entries = deriveMinimapEntries(doc(...many), sources);
    const ratios = entries.map((e) => e.ratio);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThan(ratios[i - 1]);
    }
    expect(ratios[0]).toBeGreaterThanOrEqual(0.0099);
    expect(ratios[ratios.length - 1]).toBeLessThanOrEqual(0.99);
  });

  it("returns nothing for a widget-less document", () => {
    expect(deriveMinimapEntries(doc(para("just prose")), sources)).toEqual([]);
  });
});

describe("describeDotState", () => {
  const opts = { unseen: false, queueAhead: 0 };

  it("maps each phase to its bump fill and accessible label", () => {
    // Draft and waiting states are hollow vessels; only waiting pulses.
    expect(describeDotState("composing", opts)).toMatchObject({
      core: "neutral",
      hollow: true,
      pulse: false,
      label: "Draft",
    });
    expect(describeDotState("sending", opts)).toMatchObject({
      core: "neutral",
      hollow: true,
      pulse: true,
    });
    // Running speaks through the breathing goo alone — solid, no punch.
    expect(describeDotState("running", opts)).toMatchObject({
      core: "neutral",
      hollow: false,
      label: "Running",
      breathe: true,
    });
    // Errors pulse for attention like blocked states do.
    expect(describeDotState("error", opts)).toMatchObject({
      core: "error",
      label: "Failed",
      ping: true,
    });
  });

  it("blocked-on-user states ping in the attention color", () => {
    for (const phase of ["needs-permission", "needs-auth"] as const) {
      const view = describeDotState(phase, opts);
      expect(view.core).toBe("attention");
      expect(view.ping).toBe(true);
    }
    expect(describeDotState("needs-permission", opts).label).toBe(
      "Needs permission",
    );
    expect(describeDotState("needs-auth", opts).label).toBe("Needs sign-in");
  });

  it("queued spells out the position", () => {
    expect(describeDotState("queued", { ...opts, queueAhead: 0 }).label).toBe(
      "Queued · next",
    );
    expect(describeDotState("queued", { ...opts, queueAhead: 2 }).label).toBe(
      "Queued · 2 ahead",
    );
  });

  it("a done round that answered with an issue gets the error core", () => {
    expect(
      describeDotState("done", { ...opts, unseen: true, issue: true }),
    ).toMatchObject({ core: "error", ping: true });
    expect(
      describeDotState("done", { ...opts, unseen: false, issue: true }),
    ).toMatchObject({ core: "error", ping: false });
    // Answers (kind "answer") and plain completions stay fresh.
    expect(
      describeDotState("done", { ...opts, unseen: true, issue: false }),
    ).toMatchObject({ core: "fresh" });
  });

  it("done pulses for attention until seen, then settles to a bare dot", () => {
    expect(describeDotState("done", { ...opts, unseen: true })).toMatchObject({
      core: "fresh",
      label: "Done · unread",
      ping: true,
    });
    expect(describeDotState("done", { ...opts, unseen: false })).toMatchObject({
      core: "neutral",
      label: "Done",
      ping: false,
    });
  });

  it("settled states hold still — no motion outside live phases", () => {
    for (const phase of ["composing", "done"] as const) {
      const view = describeDotState(phase, opts);
      expect(view.breathe || view.pulse || view.ping).toBe(false);
    }
  });
});
