import { describe, it, expect } from "vitest";
import { calculateContentHash } from "../hash";

describe("calculateContentHash", () => {
  it("produces standard MD5 digests (agrees with Rust's md5 of UTF-8 bytes)", () => {
    expect(calculateContentHash("hello")).toBe(
      "5d41402abc4b2a76b9719d911017c592",
    );
    expect(calculateContentHash("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });

  it("handles multibyte content", () => {
    // Same content must hash identically however it reaches us.
    expect(calculateContentHash("héllo 🌍")).toBe(
      calculateContentHash("héllo \u{1F30D}"),
    );
  });

  it("does not throw on lone surrogates and matches the lossy read-back", () => {
    // The md5 package's string path throws URIError here, which made every
    // save of such a document fail (MET-71 #2). TextEncoder replaces the
    // lone surrogate with U+FFFD — the same content Rust reads back after
    // the lossy disk write, so the digests must agree.
    const lone = "abc" + String.fromCharCode(0xd800) + "def";
    expect(() => calculateContentHash(lone)).not.toThrow();
    expect(calculateContentHash(lone)).toBe(calculateContentHash("abc�def"));
  });
});
