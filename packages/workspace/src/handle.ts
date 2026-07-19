/**
 * Generic handle builder. Every entity handle in this package (Tab, Editor,
 * File, Blob, GitStatus) is identity fields plus a table of zero-arg
 * methods, each computed fresh from the handle itself on every call — no
 * exceptions, so "no cached state" is a property of `createHandle` rather
 * than something every module has to separately get right.
 *
 * This also makes relations symmetric by construction: a module declares
 * its whole method table — reads (`isMounted`, `content`, `state`) and
 * graph edges to other entities (`file`, `tab`, `editor`, `blobs`) — as one
 * flat object literal, instead of hand-writing each method body. Missing or
 * mismatched edges (e.g. `EditorHandle.file()` existing with no
 * `FileHandle.editor()` back) show up as a plain missing table entry, not a
 * hand-written method nobody thought to add.
 */
export type HandleMethods<Self> = Record<string, (self: Self) => unknown>;

export function createHandle<Identity extends object, Methods extends HandleMethods<Identity>>(
  identity: Identity,
  methods: Methods,
): Identity & { [K in keyof Methods]: () => ReturnType<Methods[K]> } {
  type Handle = Identity & { [K in keyof Methods]: () => ReturnType<Methods[K]> };
  const handle = { ...identity } as Handle;
  for (const key of Object.keys(methods) as Array<keyof Methods & string>) {
    Object.defineProperty(handle, key, {
      value: () => methods[key](handle),
      enumerable: true,
    });
  }
  return handle;
}
