import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  TEXT_PROMPT_EVENT,
  type TextPromptRequestDetail,
} from "@/utils/text-prompt";

/**
 * In-app single-line text prompt, mounted once in App.
 * Serves platformAdapter.promptText() on every platform — window.prompt
 * does not exist inside the Tauri webview.
 */
export function TextPromptDialog() {
  const [request, setRequest] = useState<TextPromptRequestDetail | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<TextPromptRequestDetail>).detail;
      setValue(detail.defaultValue ?? "");
      setRequest(detail);
    };

    window.addEventListener(TEXT_PROMPT_EVENT, handleRequest);
    return () => window.removeEventListener(TEXT_PROMPT_EVENT, handleRequest);
  }, []);

  const settle = (result: string | null) => {
    request?.callback(result);
    setRequest(null);
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
    >
      <DialogContent className="sm:max-w-[26.25rem]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            settle(value);
          }}
        >
          <DialogHeader>
            <DialogTitle>{request?.title}</DialogTitle>
            {request?.message && (
              <DialogDescription>{request.message}</DialogDescription>
            )}
          </DialogHeader>
          <div className="py-4">
            <Input
              autoFocus
              value={value}
              placeholder={request?.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => e.target.select()}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => settle(null)}
            >
              Cancel
            </Button>
            <Button type="submit">{request?.confirmLabel ?? "OK"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
