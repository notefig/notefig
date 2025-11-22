import * as React from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/icons";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = React.useState("general");

  const menuItems = [
    { id: "general", label: "General", icon: Icons.settings },
    { id: "editor", label: "Editor", icon: Icons.fileText },
    { id: "appearance", label: "Appearance", icon: Icons.image },
    { id: "shortcuts", label: "Shortcuts", icon: Icons.command },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 p-0 overflow-hidden">
        <div className="grid h-[600px] grid-cols-[250px_1fr]">
          <aside className="border-r bg-muted/30 flex flex-col">
            <div className="p-6 pb-4 border-b">
              <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
              <p className="text-sm text-muted-foreground">
                Manage your preferences
              </p>
            </div>
            <div className="flex-1 overflow-y-auto py-4">
              <nav className="grid gap-1 px-2">
                {menuItems.map((item) => (
                  <Button
                    key={item.id}
                    variant="ghost"
                    className={cn(
                      "justify-start gap-2 px-3",
                      activeTab === item.id &&
                        "bg-accent text-accent-foreground",
                    )}
                    onClick={() => setActiveTab(item.id)}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Button>
                ))}
              </nav>
            </div>
          </aside>
          <main className="flex-1 overflow-y-auto bg-background">
            <div className="p-6 space-y-6">
              <div className="pb-4 border-b">
                <h3 className="text-2xl font-bold tracking-tight capitalize">
                  {activeTab}
                </h3>
                <p className="text-muted-foreground">
                  Manage your {activeTab} settings and preferences.
                </p>
              </div>

              {activeTab === "general" && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <Label className="text-base">Auto-save</Label>
                      <p className="text-sm text-muted-foreground">
                        Automatically save your changes as you type.
                      </p>
                    </div>
                    <Switch defaultChecked />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <Label className="text-base">Notifications</Label>
                      <p className="text-sm text-muted-foreground">
                        Receive notifications about updates and sync status.
                      </p>
                    </div>
                    <Switch defaultChecked />
                  </div>
                </div>
              )}

              {activeTab === "editor" && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <Label className="text-base">Line Numbers</Label>
                      <p className="text-sm text-muted-foreground">
                        Show line numbers in the editor gutter.
                      </p>
                    </div>
                    <Switch defaultChecked />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <Label className="text-base">Word Wrap</Label>
                      <p className="text-sm text-muted-foreground">
                        Wrap long lines to fit within the editor width.
                      </p>
                    </div>
                    <Switch defaultChecked />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <Label className="text-base">Minimap</Label>
                      <p className="text-sm text-muted-foreground">
                        Show a minimap overview of the file.
                      </p>
                    </div>
                    <Switch />
                  </div>
                </div>
              )}

              {activeTab === "appearance" && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <Label className="text-base">Dark Mode</Label>
                      <p className="text-sm text-muted-foreground">
                        Use dark theme for the application interface.
                      </p>
                    </div>
                    <Switch defaultChecked />
                  </div>
                  <div className="flex items-center justify-between rounded-lg border">
                    <div className="space-y-0.5">
                      <Label className="text-base">Transparent Sidebar</Label>
                      <p className="text-sm text-muted-foreground">
                        Make the file explorer sidebar slightly transparent.
                      </p>
                    </div>
                    <Switch />
                  </div>
                </div>
              )}

              {activeTab === "shortcuts" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="p-3 rounded-md border bg-muted/30 flex justify-between items-center">
                      <span>Save File</span>
                      <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                        <span className="text-xs">⌘</span>S
                      </kbd>
                    </div>
                    <div className="p-3 rounded-md border bg-muted/30 flex justify-between items-center">
                      <span>Open File</span>
                      <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                        <span className="text-xs">⌘</span>O
                      </kbd>
                    </div>
                    <div className="p-3 rounded-md border bg-muted/30 flex justify-between items-center">
                      <span>Command Palette</span>
                      <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                        <span className="text-xs">⌘</span>K
                      </kbd>
                    </div>
                    <div className="p-3 rounded-md border bg-muted/30 flex justify-between items-center">
                      <span>Toggle Sidebar</span>
                      <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
                        <span className="text-xs">⌘</span>B
                      </kbd>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
