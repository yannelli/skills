import { useCallback, useEffect, useState } from 'react';
import { messageOf } from './format';

export type Resource<T> = {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  /** Refetch with whatever the current loader closes over. */
  reload: () => void;
};

type State<T> = {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
};

/**
 * One fetch, with its loading and error states, driven by a memoised loader.
 * Pass a `useCallback` whose dependencies are the request parameters: changing
 * them refetches, and nothing else does.
 *
 * The previous value is kept while a refetch is in flight so a slow probe does
 * not blank the page the user is reading.
 */
export function useResource<T>(load: () => Promise<T>, fallbackError: string): Resource<T> {
  const [state, setState] = useState<State<T>>({ data: undefined, error: undefined, loading: true });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setState((previous) => ({ data: previous.data, error: undefined, loading: true }));
    load().then(
      (data) => {
        if (live) {
          setState({ data, error: undefined, loading: false });
        }
      },
      (error: unknown) => {
        if (live) {
          setState((previous) => ({
            data: previous.data,
            error: messageOf(error, fallbackError),
            loading: false
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

  return { data: state.data, error: state.error, loading: state.loading, reload };
}
