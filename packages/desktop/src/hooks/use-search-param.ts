import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

interface SearchParamUpdateOptions {
  replace?: boolean;
}

type SearchParamMutator = (next: URLSearchParams) => void;

interface UseSearchParamResult {
  searchParams: URLSearchParams;
  setSearchParams: (
    mutator: SearchParamMutator,
    options?: SearchParamUpdateOptions,
  ) => void;
}

function cloneParams(params: URLSearchParams): URLSearchParams {
  return new URLSearchParams(params);
}

export function useSearchParam(): UseSearchParamResult {
  const [urlSearchParams, setUrlSearchParams] = useSearchParams();
  const [optimisticSearchParams, setOptimisticSearchParams] = useState(() =>
    cloneParams(urlSearchParams),
  );
  const optimisticRef = useRef(optimisticSearchParams);

  useEffect(() => {
    optimisticRef.current = optimisticSearchParams;
  }, [optimisticSearchParams]);

  useEffect(() => {
    const nextFromUrl = cloneParams(urlSearchParams);

    if (nextFromUrl.toString() === optimisticRef.current.toString()) {
      return;
    }

    optimisticRef.current = nextFromUrl;
    setOptimisticSearchParams(nextFromUrl);
  }, [urlSearchParams]);

  const setSearchParams = useCallback(
    (mutator: SearchParamMutator, options?: SearchParamUpdateOptions) => {
      const next = cloneParams(optimisticRef.current);
      mutator(next);

      optimisticRef.current = next;
      setOptimisticSearchParams(next);
      setUrlSearchParams(next, { replace: options?.replace ?? true });
    },
    [setUrlSearchParams],
  );

  return {
    searchParams: optimisticSearchParams,
    setSearchParams,
  };
}
