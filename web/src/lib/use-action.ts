import { useCallback, useState } from 'react';
import type { ActionResult } from './api';
import { messageOf } from './format';

export type ActionFeedback = {
  ok: boolean;
  /** The row the action was fired from, so the table can mark it. */
  key: string;
  message: string;
  /** The file the change landed in. Absent on failure. */
  file?: string;
  backup?: string;
};

export type ActionRunner = {
  /** Key of the row whose action is in flight, or undefined. */
  pending: string | undefined;
  feedback: ActionFeedback | undefined;
  run: (key: string, action: () => Promise<ActionResult>) => void;
  dismiss: () => void;
};

/**
 * Runs one config mutation at a time and keeps its outcome. Every rejection is
 * caught here — a failed write must show up as a message, not as an unhandled
 * promise.
 */
export function useAction(onChanged: () => void): ActionRunner {
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [feedback, setFeedback] = useState<ActionFeedback | undefined>(undefined);

  const run = useCallback(
    (key: string, action: () => Promise<ActionResult>) => {
      setPending(key);
      setFeedback(undefined);
      action().then(
        (result) => {
          setPending(undefined);
          setFeedback({
            ok: true,
            key,
            message: result.detail,
            ...(result.file ? { file: result.file } : {}),
            ...(result.backup ? { backup: result.backup } : {})
          });
          onChanged();
        },
        (error: unknown) => {
          setPending(undefined);
          setFeedback({ ok: false, key, message: messageOf(error, 'the change could not be written') });
        }
      );
    },
    [onChanged]
  );

  const dismiss = useCallback(() => {
    setFeedback(undefined);
  }, []);

  return { pending, feedback, run, dismiss };
}
