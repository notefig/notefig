/**
 * The session picker in a composing widget's draft row (MET-284). Its
 * trigger is the mark of the session the next prompt goes to, so the widget
 * names its session the same way everywhere: a bound or adopted session's
 * mark, or, before there is one, the logo of the harness a new session
 * would start on. The menu lists the workspace's recent live sessions by
 * their marks, each with its harness's name in small text before its title
 * (the target's in medium), then a new conversation on each of the top
 * harnesses (no session yet, so those keep the harness logo); picking one
 * also becomes the remembered default (the sessions panel's split-button
 * rule).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@notefig/ui/button";
import { VoiceWave } from "@notefig/ui/voice-wave";
import { IconSwap } from "@notefig/ui/icon-swap";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import { Tooltip, TooltipTrigger } from "@notefig/ui/tooltip";
import { usePromptWidgetHost } from "../host-context";
import type { SessionOption } from "../host";
import { SessionMarkIcon } from "../session-mark";
import { SessionTooltip } from "./session-button";

/** The session the widget's prompts go to: its bound session, else the one
 *  a send would join. Undefined when that session isn't live, or there is
 *  none yet (a send starts one). */
function useTargetSession(
  workspacePath: string,
  boundTaskId: string | null | undefined,
): SessionOption | undefined {
  const host = usePromptWidgetHost();
  const sessions = host.useSessionList(workspacePath);
  const taskId = boundTaskId ?? host.peekSession(workspacePath);
  return sessions.find((session) => session.taskId === taskId);
}

/** The harness the widget's prompts go to: its target session's, else the
 *  default (a new session would start on it). */
export function useTargetHarnessId(
  workspacePath: string,
  boundTaskId: string | null | undefined,
): string {
  const harnesses = usePromptWidgetHost().useHarnessList();
  return useTargetSession(workspacePath, boundTaskId)?.harnessId ?? harnesses[0].id;
}

export function SessionPicker({
  workspacePath,
  boundTaskId,
  onSelectSession,
  onNewSession,
  onClose,
}: {
  workspacePath: string;
  /** The session this widget is already bound to (a restored widget, MET-163)
   *  — the trigger must name where the prompt will actually go, which is this
   *  task rather than the workspace's shared session. */
  boundTaskId?: string | null;
  /** Re-target a bound widget. Absent for an unbound one, whose selection
   *  just moves the shared session as it always did. */
  onSelectSession?: (taskId: string) => void;
  /** Start this widget on a new session. Absent: the selection just drops
   *  the workspace's shared session. */
  onNewSession?: (harnessId: string) => void;
  /** The menu is a detour from typing: when it closes, the caret goes back
   *  to the composer (as the chat tab's pickers do). */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const host = usePromptWidgetHost();
  const { HarnessLogo } = host.slots;
  // Default first, never empty — the top three become the explicit
  // new-conversation entries below.
  const harnesses = host.useHarnessList();
  // Already filtered to live sessions and ordered newest-first by the host.
  const sessions = host.useSessionList(workspacePath);
  const target = useTargetSession(workspacePath, boundTaskId);
  const [open, setOpen] = useState(false);

  const harnessLabel = (harnessId: string) =>
    harnesses.find((harness) => harness.id === harnessId)?.label ?? harnessId;
  const recentSessions = sessions.slice(0, 5);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="dictation-swap size-7 shrink-0 cursor-pointer rounded-lg text-muted-foreground"
              aria-label={t("agentChooseHarness")}
              data-session-picker={target?.taskId ?? ""}
            >
              {/* While someone dictates into this draft, the wave stands in
                  for the mark (styles.css cross-fades them on the dictation
                  ghost). */}
              {/* A change of target shrinks one icon and grows the next. */}
              <IconSwap
                swapKey={target ? `session:${target.taskId}` : `harness:${harnesses[0].id}`}
                className="dictation-idle-only"
              >
                {target ? (
                  <SessionMarkIcon
                    colorSlot={target.colorSlot}
                    shapeSlot={target.shapeSlot}
                    size={16}
                  />
                ) : (
                  <HarnessLogo harnessId={harnesses[0].id} />
                )}
              </IconSwap>
              {host.dictation && (
                <VoiceWave level={host.dictation.level} hearing={host.dictation.hearing} size="1.05rem" className="dictation-active-only" />
              )}
            </Button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <SessionTooltip
          harness={target ? harnessLabel(target.harnessId) : undefined}
          title={target?.title ?? t("agentChooseHarness")}
        />
      </Tooltip>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => {
          // Radix would hand focus back to the trigger.
          event.preventDefault();
          onClose();
        }}
      >
        {recentSessions.length > 0 && (
          <>
            {recentSessions.map((session) => (
              <DropdownMenuItem
                key={session.taskId}
                className="cursor-pointer gap-2 text-xs"
                data-session-option={session.taskId}
                aria-current={session.taskId === target?.taskId || undefined}
                onSelect={() =>
                  onSelectSession
                    ? onSelectSession(session.taskId)
                    : host.adoptSession(workspacePath, session.taskId)
                }
              >
                <SessionMarkIcon colorSlot={session.colorSlot} shapeSlot={session.shapeSlot} />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                    {harnessLabel(session.harnessId)}
                  </span>
                  {/* The session the next prompt goes to reads in medium. */}
                  <span
                    className={
                      session.taskId === target?.taskId
                        ? "min-w-0 truncate font-medium"
                        : "min-w-0 truncate"
                    }
                  >
                    {session.title}
                  </span>
                </span>
                <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                  {session.description}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {harnesses.slice(0, 3).map((harness) => (
          <DropdownMenuItem
            key={harness.id}
            className="cursor-pointer gap-2 text-xs"
            onSelect={() =>
              onNewSession
                ? onNewSession(harness.id)
                : host.dropSession(workspacePath, harness.id)
            }
          >
            <HarnessLogo
              harnessId={harness.id}
              className="size-3.5 text-muted-foreground"
            />
            {t("promptBlobNewSessionWith", { harness: harness.label })}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
