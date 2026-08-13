import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { Markdown } from "@/components/ui/markdown";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(text: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Markdown, { text })));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("Markdown", () => {
  it("renders markdown structure (bold, inline code, lists)", () => {
    render("**bold** and `code`\n\n- one\n- two");
    expect(container!.querySelector("strong")?.textContent).toBe("bold");
    expect(container!.querySelector("code")?.textContent).toBe("code");
    expect(container!.querySelectorAll("li")).toHaveLength(2);
  });

  it("escapes raw HTML in model output instead of rendering it", () => {
    render('<img src=x onerror="boom()"> hi');
    expect(container!.querySelector("img")).toBeNull();
    expect(container!.textContent).toContain("<img");
  });

  it("linkifies bare URLs", () => {
    render("see https://example.com for more");
    const anchor = container!.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
  });
});
