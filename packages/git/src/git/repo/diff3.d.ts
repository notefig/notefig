declare module "diff3" {
  type Diff3Region<T> =
    | { ok: T[] }
    | {
        conflict: {
          a: T[];
          aIndex: number;
          o: T[];
          oIndex: number;
          b: T[];
          bIndex: number;
        };
      };
  /** diff3 of `a` and `b` against their common ancestor `o`. */
  export default function diff3Merge<T>(
    a: T[],
    o: T[],
    b: T[],
  ): Diff3Region<T>[];
}
