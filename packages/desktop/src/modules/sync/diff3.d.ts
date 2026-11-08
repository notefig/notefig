/** `diff3` ships no types; this is the one call sync makes. */
declare module "diff3" {
  type Region<T> =
    | { ok: T[]; conflict?: undefined }
    | { ok?: undefined; conflict: { a: T[]; o: T[]; b: T[] } };
  export default function diff3Merge<T>(a: T[], o: T[], b: T[]): Region<T>[];
}
