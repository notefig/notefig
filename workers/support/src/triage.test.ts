import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { classifier, decisionInput, labelIds, type TriageConfig } from "./triage.ts";

const config: TriageConfig = {
  model: "typesafe/jev",
  typeLabelIds: labelIds("Bug=bug-id, Feature = feature-id,Improvement=improvement-id"),
  modelLabelIds: labelIds("Kimi K2.7 Code=kimi-id,GLM 5.3=glm-id,Unknown Model=unknown-id"),
};

const answer = (choice: string, probability: number) => ({
  type: "choice",
  choice,
  confidence: probability / 2,
  probabilities: { [choice]: probability, Other: 1 - probability },
});

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const error = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = error;
  }
}

test("reads Name=id pairs, skipping broken ones", () => {
  assert.deepEqual([...labelIds(" Bug = a ,broken,=b,Feature=,GLM 5.3=c")], [
    ["Bug", "a"],
    ["GLM 5.3", "c"],
  ]);
});

test("asks about the message alone: its kind, and a model among the labels it has ids for", () => {
  const input = decisionInput("Renaming a file loses the scroll position", config);
  assert.ok(input);
  assert.equal(input.model, undefined);
  assert.equal(input.state, "App feedback from a user:\n\nRenaming a file loses the scroll position");
  assert.deepEqual(Object.keys(input.questions.type.criteria), ["Bug", "Feature", "Improvement"]);
  // Only models described here and given an id: "Unknown Model" has no meaning to offer.
  assert.deepEqual(Object.keys(input.questions.model.criteria), ["Kimi K2.7 Code", "GLM 5.3"]);
});

test("names the Clef model for Clef's API, and asks nothing without labels to choose from", () => {
  assert.equal(decisionInput("x", { ...config, model: "@cf/cloudflare/clef-flash" })?.model, "clef-flash");
  assert.equal(decisionInput("x", { model: "typesafe/jev", typeLabelIds: new Map(), modelLabelIds: new Map() }), null);
});

test("suggests the labels the model is sure enough of", async () => {
  const calls: string[] = [];
  const classify = classifier(async (model) => {
    calls.push(model);
    return { answers: { type: answer("Bug", 0.82), model: answer("GLM 5.3", 0.3) } };
  }, config);
  assert.deepEqual(await classify("It crashes"), ["bug-id"]);
  assert.deepEqual(calls, ["typesafe/jev"]);
});

test("suggests nothing for an answer it has no label for, or an answer of the wrong shape", async () => {
  const classify = classifier(async () => ({ answers: { type: answer("Question", 0.99), model: { choice: "GLM 5.3", confidence: 0.9 } } }), config);
  assert.deepEqual(await classify("Hi"), []);
  assert.deepEqual(await classifier(async () => null, config)("Hi"), []);
});

test("suggests nothing when the model fails, and doesn't throw", async () => {
  const classify = classifier(async () => {
    throw new Error("Insufficient balance; add money to your gateway or use BYOK");
  }, config);
  assert.deepEqual(await quietly(() => classify("It crashes")), []);
});

test("gives up after five seconds", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const classify = classifier(() => new Promise(() => {}), config);
    const result = quietly(() => classify("It crashes"));
    mock.timers.tick(5000);
    assert.deepEqual(await result, []);
  } finally {
    mock.timers.reset();
  }
});
