/**
 * A first guess at a new feedback issue's labels, from a decision model (Cloudflare's Clef on Workers AI, through AI
 * Gateway): which kind of issue it is (Bug, Feature, Improvement) and which build-agent model should work on it (the
 * Model labels, matching `MODEL_LABELS` in workers/build-agents). The approver still reviews both in Triage.
 *
 * Only the user's message is sent, which is what the public description holds already: never the debug report or the
 * screenshots. Best effort: a slow, failing or unsure model adds no labels, and the feedback is filed regardless.
 */

/** The label ids to add to a new feedback issue: none, one or two. */
export type Classify = (message: string) => Promise<string[]>;

/** Runs the decision model: Workers AI's `env.AI.run`, through the gateway. */
export type RunModel = (model: string, input: DecisionInput) => Promise<unknown>;

export interface TriageConfig {
  /** `@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash`. */
  model: string;
  /** Label name → Linear label id, for the kinds of issue in `TYPES`. */
  typeLabelIds: ReadonlyMap<string, string>;
  /** Label name → Linear label id, for the models in `MODELS`. */
  modelLabelIds: ReadonlyMap<string, string>;
}

export interface DecisionInput {
  /** Which Clef model: `clef` or `clef-flash`. */
  model: string;
  state: string;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
}

/** What each Linear label means, for the model. Only labels that also have an id in the config are offered. */
const TYPES: Record<string, string> = {
  Bug: "Something that worked, or obviously should work, is broken or wrong",
  Feature: "A new capability the app doesn't have",
  Improvement: "Making something that already works better: faster, clearer, easier",
};

/**
 * The build-agent models, by their Model label. Build agents pick their model from that label through the
 * `MODEL_LABELS` whitelist in workers/build-agents (MET-243); keep the names in step with it.
 */
const MODELS: Record<string, string> = {
  "Kimi K2.7 Code": "Everyday fixes and features of ordinary size: the default",
  "GLM 5.3": "Large changes that span several parts of the app",
  "GLM 5.3 Flash": "Small, well-specified changes: wording, a setting, documentation",
  "DeepSeek V4 Pro": "Hard bugs whose cause isn't obvious and needs careful reasoning",
};

/**
 * A choice whose probability is below this adds no label. The answer's probability, not its `confidence`: on real
 * feedback Clef gave 0.84 to the right kind with a confidence of 0.59, and 0.97 to the right model with 0.92.
 */
const MIN_PROBABILITY = 0.5;
const TIMEOUT_MS = 5000;

export function decisionInput(message: string, config: TriageConfig): DecisionInput | null {
  const offered = (meanings: Record<string, string>, ids: ReadonlyMap<string, string>) =>
    Object.fromEntries(Object.entries(meanings).filter(([name]) => ids.has(name)));
  const questions: DecisionInput["questions"] = {};
  const types = offered(TYPES, config.typeLabelIds);
  if (Object.keys(types).length > 1) {
    questions.type = { type: "choice", instructions: "What kind of issue does this app feedback describe?", criteria: types };
  }
  const models = offered(MODELS, config.modelLabelIds);
  if (Object.keys(models).length > 1) {
    questions.model = {
      type: "choice",
      instructions: "Which coding model should implement this feedback, judging by the size and difficulty of the change?",
      criteria: models,
    };
  }
  if (Object.keys(questions).length === 0) return null;
  return { model: config.model.replace(/^@cf\/cloudflare\//, ""), state: `App feedback from a user:\n\n${message}`, questions };
}

export function classifier(run: RunModel, config: TriageConfig): Classify {
  return async (message) => {
    const input = decisionInput(message, config);
    if (!input) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        run(config.model, input),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer in ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
        }),
      ]);
      return [
        labelFor(result, "type", config.typeLabelIds),
        labelFor(result, "model", config.modelLabelIds),
      ].filter((id): id is string => id !== undefined);
    } catch (error) {
      console.error("triage: no labels suggested", error);
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
}

type Answer = { choice?: unknown; probabilities?: Record<string, unknown> };

/** The label id for one question's answer, if the model was sure enough and the answer is a label we know. */
function labelFor(result: unknown, question: string, ids: ReadonlyMap<string, string>): string | undefined {
  const answer = (result as { answers?: Record<string, Answer> } | null)?.answers?.[question];
  if (typeof answer?.choice !== "string") return undefined;
  const probability = answer.probabilities?.[answer.choice];
  return typeof probability === "number" && probability >= MIN_PROBABILITY ? ids.get(answer.choice) : undefined;
}

/** `Name=id` pairs, comma-separated; a pair missing either side is skipped. */
export function labelIds(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (value ?? "").split(",")) {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const id = pair.slice(at + 1).trim();
    if (at > 0 && name && id) map.set(name, id);
  }
  return map;
}
