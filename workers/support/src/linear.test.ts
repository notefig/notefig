import assert from "node:assert/strict";
import { test } from "node:test";
import { linearClient } from "./linear.ts";

test("reads every page of an issue's comments, oldest first", async () => {
  const afters: (string | null)[] = [];
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { variables } = JSON.parse(String(init?.body));
    afters.push(variables.after);
    const page =
      variables.after === null
        ? {
            nodes: [{ body: "second", createdAt: "2026-10-19T10:00:00Z", user: { name: "Parsa" } }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          }
        : {
            nodes: [{ body: "first", createdAt: "2026-10-19T09:00:00Z", user: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          };
    return Response.json({ data: { issue: { comments: page } } });
  }) as typeof fetch;

  const comments = await linearClient("lin_api_test", fetchFn).issueComments("issue-uuid");
  assert.deepEqual(afters, [null, "cursor-1"]);
  assert.deepEqual(comments, [
    { author: "Linear", body: "first" },
    { author: "Parsa", body: "second" },
  ]);
});

test("downloads files from Linear's upload host only, with the API key", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
    return new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png; charset=binary" } });
  }) as typeof fetch;
  const { downloadFile } = linearClient("lin_api_test", fetchFn);

  assert.deepEqual(await downloadFile("https://uploads.linear.app/org/asset/shot"), {
    mediaType: "image/png",
    bytes: new Uint8Array([1, 2]),
  });
  for (const url of [
    "https://evil.example/shot",
    "http://uploads.linear.app/org/asset/shot",
    "https://uploads.linear.app.evil.example/shot",
    "not a url",
  ]) {
    assert.equal(await downloadFile(url), null, url);
  }
  assert.deepEqual(requests, [{ url: "https://uploads.linear.app/org/asset/shot", authorization: "lin_api_test" }]);
});
