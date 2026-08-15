import { useCallback, useEffect, useState } from 'react';
import { messageOf } from './format';

export type Resource<T> = {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  /** Refetch with whatever the current loader closes over. */
  reload: () => void;
};

/** What one finished request produced, tagged with the request it answers. */
type Settled<T> = {
  load: () => Promise<T>;
  nonce: number;
  data?: T;
  error?: string;
};

/**
 * One fetch, with its loading and error states, driven by a memoised loader.
 * Pass a `useCallback` whose dependencies are the request parameters: changing
 * them refetches, and nothing else does.
 *
 * `loading` is derived by comparing the settled result against the request in
 * flight rather than being set from inside the effect, which keeps the previous
 * value on screen while a slow probe runs instead of blanking the page.
 */
export function useResource<T>(load: () => Promise<T>, fallbackError: string): Resource<T> {
  const [settled, setSettled] = useState<Settled<T> | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    load().then(
      (data) => {
        if (live) {
          setSettled({ load, nonce, data });
        }
      },
      (error: unknown) => {
        if (live) {
          // Carry the last good value forward. A failed refetch must leave the
          // page it already drew standing, with the error beside it, rather
          // than replacing a working table with an error card.
          setSettled((previous) => ({
            load,
            nonce,
            ...(previous?.data === undefined ? {} : { data: previous.data }),
            error: messageOf(error, fallbackError)
          }));
        }
      }
    );
    return () => {
      live = false;
    };
  }, [load, nonce, fallbackError]);

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  const current = settled && settled.load === load && settled.nonce === nonce ? settled : undefined;

  return {
    data: current ? current.data : settled?.data,
    error: current?.error,
    loading: current === undefined,
    reload
  };
}
