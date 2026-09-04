import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * A boolean UI flag stored in the URL search params (`?<key>=true`),
 * shared by every site that reads or toggles it. Used for app-chrome
 * state like the settings modal (`settings`) and the debug panel
 * (`debug`) — URL-held so it survives reloads and is deep-linkable.
 */
export function useSearchParamFlag(
  key: string,
  options?: { replace?: boolean },
) {
  const [searchParams, setUrlSearchParams] = useSearchParams();
  const replace = options?.replace ?? false;
  const isOn = searchParams.get(key) === "true";

  const setFlag = useCallback(
    (on: boolean) => {
      setUrlSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (on) {
            next.set(key, "true");
          } else {
            next.delete(key);
          }
          return next;
        },
        replace ? { replace: true } : undefined,
      );
    },
    [setUrlSearchParams, key, replace],
  );

  return { isOn, setFlag };
}

/**
 * A string UI value stored in the URL search params (`?<key>=<value>`).
 * The sibling of `useSearchParamFlag` for chrome whose state is a choice
 * rather than a boolean — the settings modal (`?settings=<section>`), where
 * an absent param means closed and a present one names the open section.
 */
export function useSearchParamValue(
  key: string,
  options?: { replace?: boolean },
) {
  const [searchParams, setUrlSearchParams] = useSearchParams();
  const replace = options?.replace ?? false;
  const value = searchParams.get(key);

  const setValue = useCallback(
    (next: string | null) => {
      setUrlSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === null) {
            params.delete(key);
          } else {
            params.set(key, next);
          }
          return params;
        },
        replace ? { replace: true } : undefined,
      );
    },
    [setUrlSearchParams, key, replace],
  );

  return { value, setValue };
}
