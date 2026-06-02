import {
  parseProjectConfig,
  parseProjectConfigWithEnv,
} from "./project-config.loader";
import { PROJECT_CONFIG_SCHEMA_URL_V1 } from "./project-config.constants";
import {
  ProjectConfigEnvResolutionError,
  ProjectConfigJsonParseError,
  ProjectConfigSchemaReferenceError,
} from "./project-config.parse-errors";

const VALID_OUTPUTS = {
  web: {
    enabled: true,
    outDir: "out",
    theme: "metrists-theme-next",
    deploy: { provider: null, options: {} },
  },
  epub: { enabled: false, coverImagePath: "cover.jpg" },
  pdf: { enabled: false },
  audiobook: { enabled: false },
};

const AUDIOBOOK_OUTPUT_WITH_ENV_REFS = {
  enabled: true,
  provider: "elevenlabs",
  apiKey: "$ELEVENLABS_API_KEY",
  voiceId: "$ELEVENLABS_VOICE_ID",
  modelId: "eleven_multilingual_v2",
  format: "mp3_44100_128",
};

describe("project config schema", () => {
  it("accepts a valid minimal v1 config", () => {
    const raw = JSON.stringify({
      $schema: PROJECT_CONFIG_SCHEMA_URL_V1,
      outputs: VALID_OUTPUTS,
    });

    const result = parseProjectConfig(raw);
    expect(result.outputs.web.outDir).toBe("out");
  });

  it("throws when $schema is missing", () => {
    const raw = JSON.stringify({
      outputs: VALID_OUTPUTS,
    });

    expect(() => parseProjectConfig(raw)).toThrow(
      ProjectConfigSchemaReferenceError,
    );
  });

  it("throws for unsupported $schema URL", () => {
    const raw = JSON.stringify({
      $schema:
        "https://raw.githubusercontent.com/metrists/metrists/main/schemas/project-config/v2.schema.json",
      outputs: VALID_OUTPUTS,
    });

    expect(() => parseProjectConfig(raw)).toThrow(
      ProjectConfigSchemaReferenceError,
    );
  });

  it("throws parse error for malformed JSON", () => {
    expect(() => parseProjectConfig('{"$schema":')).toThrow(
      ProjectConfigJsonParseError,
    );
  });

  it("resolves env var references when env is provided", () => {
    const raw = JSON.stringify({
      $schema: PROJECT_CONFIG_SCHEMA_URL_V1,
      outputs: {
        ...VALID_OUTPUTS,
        audiobook: AUDIOBOOK_OUTPUT_WITH_ENV_REFS,
      },
    });

    const result = parseProjectConfigWithEnv(raw, {
      ELEVENLABS_API_KEY: "api-key-value",
      ELEVENLABS_VOICE_ID: "voice-id-value",
    });

    expect(result.outputs.audiobook.apiKey).toBe("api-key-value");
    expect(result.outputs.audiobook.voiceId).toBe("voice-id-value");
  });

  it("throws when required env var is missing", () => {
    const raw = JSON.stringify({
      $schema: PROJECT_CONFIG_SCHEMA_URL_V1,
      outputs: {
        ...VALID_OUTPUTS,
        audiobook: AUDIOBOOK_OUTPUT_WITH_ENV_REFS,
      },
    });

    expect(() =>
      parseProjectConfigWithEnv(raw, {
        ELEVENLABS_API_KEY: "api-key-value",
      }),
    ).toThrow(ProjectConfigEnvResolutionError);
  });
});
