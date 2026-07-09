import { renderToolGuidance } from "./tool-guidance";

describe("renderToolGuidance", () => {
  it("lists every tool by name and description", () => {
    const text = renderToolGuidance([
      { name: "workspace_list_documents", description: "List documents." },
      { name: "history_log", description: "List checkpoints." },
    ]);
    expect(text).toContain("```metrists:tool");
    expect(text).toContain("- workspace_list_documents: List documents.");
    expect(text).toContain("- history_log: List checkpoints.");
    expect(text).toContain("AT MOST ONE tool fence per reply");
  });
});
