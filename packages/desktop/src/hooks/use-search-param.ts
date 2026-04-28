import { useCallback, useEffect, useState } from "react";
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

const subscribers = new Set<(search: string) => void>();
let sharedSearch = "";
let isSharedSearchInitialized = false;

function notifySharedSearch(search: string): void {
  subscribers.forEach((subscriber) => subscriber(search));
}

function toSearchString(params: URLSearchParams): string {
  return params.toString();
}

function fromSearchString(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

export function useSearchParam(): UseSearchParamResult {
  const [urlSearchParams, setUrlSearchParams] = useSearchParams();

  if (!isSharedSearchInitialized) {
    sharedSearch = toSearchString(urlSearchParams);
    isSharedSearchInitialized = true;
  }

  const [optimisticSearchParams, setOptimisticSearchParams] = useState(() =>
    fromSearchString(sharedSearch),
  );

  useEffect(() => {
    const subscriber = (search: string) => {
      const next = fromSearchString(search);
      setOptimisticSearchParams(next);
    };

    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  useEffect(() => {
    const urlSearch = toSearchString(urlSearchParams);

    if (urlSearch === sharedSearch) {
      return;
    }

    sharedSearch = urlSearch;
    notifySharedSearch(sharedSearch);
  }, [urlSearchParams]);

  const setSearchParams = useCallback(
    (mutator: SearchParamMutator, options?: SearchParamUpdateOptions) => {
      const next = fromSearchString(sharedSearch);
      mutator(next);

      const nextSearch = toSearchString(next);
      if (nextSearch === sharedSearch) {
        return;
      }

      sharedSearch = nextSearch;
      setOptimisticSearchParams(next);
      notifySharedSearch(sharedSearch);
      setUrlSearchParams(next, { replace: options?.replace ?? true });
    },
    [setUrlSearchParams],
  );

  return {
    searchParams: optimisticSearchParams,
    setSearchParams,
  };
}
