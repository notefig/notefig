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
