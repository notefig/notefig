import { parseProjectConfig } from "./project-config.loader";
import { PROJECT_CONFIG_SCHEMA_URL_V1 } from "./project-config.constants";
import {
  ProjectConfigJsonParseError,
  ProjectConfigSchemaReferenceError,
} from "./project-config.parse-errors";

describe("project config schema", () => {
  it("accepts a valid minimal v1 config", () => {
    const raw = JSON.stringify({
      $schema: PROJECT_CONFIG_SCHEMA_URL_V1,
      editing: { textDirection: "ltr" },
      lifecycle: { git: { enabled: true } },
      outputs: {
        web: {
          enabled: true,
          outDir: "out",
          theme: "metrists-theme-next",
          deploy: { provider: null, options: {} },
        },
        epub: { enabled: false, coverImagePath: "cover.jpg" },
        pdf: { enabled: false },
        audiobook: {
          enabled: false,
          provider: "elevenlabs",
          apiKey: "$ELEVENLABS_API_KEY",
          voiceId: "$ELEVENLABS_VOICE_ID",
          modelId: "eleven_multilingual_v2",
          format: "mp3_44100_128",
        },
      },
    });

    const result = parseProjectConfig(raw);
    expect(result.outputs.web.outDir).toBe("out");
  });

  it("throws when $schema is missing", () => {
    const raw = JSON.stringify({
      editing: { textDirection: "ltr" },
      lifecycle: { git: { enabled: true } },
      outputs: {
        web: {
          enabled: true,
          outDir: "out",
          theme: "metrists-theme-next",
          deploy: { provider: null, options: {} },
        },
        epub: { enabled: false, coverImagePath: "cover.jpg" },
        pdf: { enabled: false },
        audiobook: {
          enabled: false,
          provider: "elevenlabs",
          apiKey: "$ELEVENLABS_API_KEY",
          voiceId: "$ELEVENLABS_VOICE_ID",
          modelId: "eleven_multilingual_v2",
          format: "mp3_44100_128",
        },
      },
    });

    expect(() => parseProjectConfig(raw)).toThrow(
      ProjectConfigSchemaReferenceError,
    );
  });

  it("throws for unsupported $schema URL", () => {
    const raw = JSON.stringify({
      $schema:
        "https://raw.githubusercontent.com/metrists/metrists/main/schemas/project-config/v2.schema.json",
      editing: { textDirection: "ltr" },
      lifecycle: { git: { enabled: true } },
      outputs: {
        web: {
          enabled: true,
          outDir: "out",
          theme: "metrists-theme-next",
          deploy: { provider: null, options: {} },
        },
        epub: { enabled: false, coverImagePath: "cover.jpg" },
        pdf: { enabled: false },
        audiobook: {
          enabled: false,
          provider: "elevenlabs",
          apiKey: "$ELEVENLABS_API_KEY",
          voiceId: "$ELEVENLABS_VOICE_ID",
          modelId: "eleven_multilingual_v2",
          format: "mp3_44100_128",
        },
      },
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
});
