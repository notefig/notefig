# Refactor plan

<!-- notefig:prompt id="blob_lx2k9a7f3" task="task_abc123" -->

The agent rewrote the parser:

```ts diff
--- a/src/parse.ts
+++ b/src/parse.ts
@@ -1,4 +1,4 @@
 export function parse(s: string) {
-  return s.split(",");
+  return s.split(/,\s*/);
 }
```

```diff
- a plain diff-language fence
+ is not a diff block
```

~~~python
def f():
    return 1
~~~

    indented code block

<!-- notefig:prompt id="blob_second" task="task_def456" -->

![diagram](assets/diagram.png "Architecture")

<details>
<summary>Raw HTML block</summary>

Kept as an opaque atom.

</details>

Footnote reference[^1] and a [reference link][ref].

[^1]: The footnote body.

[ref]: https://example.com/ref "Ref"
