import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Env, modelFor, readConfig } from "./config.ts";

const config = (MODEL_LABELS: string) => readConfig({ ...(env as unknown as Env), MODEL_PROVIDER: "gateway", MODEL_ID: "default-model", MODEL_LABELS });

describe("MODEL_LABELS", () => {
	it("reads Label=modelId pairs, ignoring case, spaces and broken pairs", () => {
		const { modelLabels } = config(" GLM 5.3 = workers-ai/@cf/zai-org/glm-5.3 ,Broken,=no-label, NoModel= ,Kimi=workers-ai/@cf/moonshotai/kimi-k2.7-code");
		expect([...modelLabels]).toEqual([
			["glm 5.3", "workers-ai/@cf/zai-org/glm-5.3"],
			["kimi", "workers-ai/@cf/moonshotai/kimi-k2.7-code"],
		]);
	});

	it("picks the first whitelisted label's model, on the configured provider", () => {
		const whitelist = config("GLM 5.3=glm,Kimi=kimi");
		expect(modelFor(["Bug", "glm 5.3", "Kimi"], whitelist)).toEqual({ model: { provider: "gateway", modelId: "glm" }, label: "glm 5.3" });
	});

	it("falls back to the default without a whitelisted label, so no other model id is used", () => {
		const whitelist = config("GLM 5.3=glm");
		expect(modelFor([], whitelist)).toEqual({ model: { provider: "gateway", modelId: "default-model" } });
		expect(modelFor(["workers-ai/@cf/some/other-model", "Claude Opus"], whitelist)).toEqual({
			model: { provider: "gateway", modelId: "default-model" },
		});
		expect(modelFor(["GLM 5.3"], config(""))).toEqual({ model: { provider: "gateway", modelId: "default-model" } });
	});
});
