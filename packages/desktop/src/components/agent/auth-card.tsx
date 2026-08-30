/**
 * Auth-blocked task: sign-in methods off the task row.
 *
 * Its own module rather than part of the chat tab because the prompt widget
 * renders it too — as a host slot (@notefig/widgets), which must not pull the
 * whole transcript view in behind it.
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { AuthMethod } from "@notefig/shared/agent";
import { Button } from "@notefig/ui/button";
import { cn } from "@notefig/ui/utils";
import type { AgentTaskRow } from "@/agent/agent-collections";
import {
  authenticateAgentTask,
  retryAgentTaskAfterAuth,
} from "@/agent/agent-service";

export function AuthCard({
  task,
  bare = false,
}: {
  task: AgentTaskRow;
  /** Skip the card's own border/bg/padding — for hosts (the prompt-blob
   *  widget) that already wrap it in an equivalently-tinted container. */
  bare?: boolean;
}) {
  const { t } = useTranslation();
  const [instructions, setInstructions] = useState<string | null>(null);
  const [busyMethodId, setBusyMethodId] = useState<string | null>(null);
  const methods = task.authMethods ?? [];

  const tryMethod = useCallback(
    async (method: AuthMethod) => {
      setBusyMethodId(method.id);
      setInstructions(null);
      const result = await authenticateAgentTask(task.taskId, method.id);
      setBusyMethodId(null);
      if (!result.ok) {
        // Out-of-band method: show how to sign in instead.
        setInstructions(method.description ?? task.authHint ?? null);
      }
    },
    [task.taskId, task.authHint],
  );

  return (
    <div
      className={cn(
        "pointer-events-auto flex flex-col gap-2 text-xs",
        // The amber tint rides a gradient *image* over an opaque
        // bg-background: this card floats in the composer overlay above the
        // transcript, so a plain translucent bg would let entries underneath
        // show through it. `bare` hosts (the prompt-blob widget) already
        // wrap this in their own equivalently-tinted card, so they skip it.
        !bare &&
          "rounded-md border border-amber-500/40 bg-background bg-gradient-to-b from-amber-500/10 to-amber-500/10 p-3",
      )}
    >
      <span className="font-medium">{t("agentSignInRequired")}</span>
      {instructions ? (
        <p className="whitespace-pre-wrap">{instructions}</p>
      ) : (
        task.authHint && <p className="whitespace-pre-wrap">{task.authHint}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {methods.map((method) => (
          <Button
            key={method.id}
            size="sm"
            variant="outline"
            disabled={busyMethodId !== null}
            onClick={() => void tryMethod(method)}
          >
            {busyMethodId === method.id && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {method.name ?? method.id}
          </Button>
        ))}
        <Button size="sm" onClick={() => retryAgentTaskAfterAuth(task.taskId)}>
          {t("agentSignedInRetry")}
        </Button>
      </div>
    </div>
  );
}
