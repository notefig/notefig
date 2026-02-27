"use client";

import React from "react";

import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  X,
  Settings,
  Pencil,
  FileText,
  Palette,
  Keyboard,
  Key,
  Package,
  Puzzle,
  Link2,
  LayoutGrid,
  Terminal,
  CalendarDays,
  History,
  PenTool,
  Eye,
  Search,
  RefreshCw,
  FileCode,
  Download,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { useUpdater } from "@/hooks/use-updater";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme-provider";
import { useSearchParams } from "react-router";

interface SettingsModalProps {
  direction: "ltr" | "rtl";
  onDirectionChange: (direction: "ltr" | "rtl") => void;
}

interface SettingsSection {
  label: string;
  items: {
    id: string;
    label: string;
    icon: React.ElementType;
  }[];
}

const settingsSections: SettingsSection[] = [
  {
    label: "projectSettings",
    items: [
      { id: "general", label: "General", icon: Settings },
      { id: "editor", label: "Editor", icon: Pencil },
      { id: "files", label: "Files and links", icon: FileText },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "hotkeys", label: "Hotkeys", icon: Keyboard },
      { id: "keychain", label: "Keychain", icon: Key },
      { id: "core-plugins", label: "Core plugins", icon: Package },
      { id: "community-plugins", label: "Community plugins", icon: Puzzle },
    ],
  },
  {
    label: "Core plugins",
    items: [
      { id: "backlinks", label: "Backlinks", icon: Link2 },
      { id: "canvas", label: "Canvas", icon: LayoutGrid },
      { id: "command-palette", label: "Command palette", icon: Terminal },
      { id: "daily-notes", label: "Daily notes", icon: CalendarDays },
      { id: "file-recovery", label: "File recovery", icon: History },
      { id: "note-composer", label: "Note composer", icon: PenTool },
      { id: "page-preview", label: "Page preview", icon: Eye },
      { id: "quick-switcher", label: "Quick switcher", icon: Search },
      { id: "sync", label: "Sync", icon: RefreshCw },
      { id: "templates", label: "Templates", icon: FileCode },
    ],
  },
];

// Settings state types
interface SettingsState {
  language: string;
  notifySlowStartup: boolean;
}

export function SettingsModal({
  direction,
  onDirectionChange,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const handleSettingsToggle = (open: boolean) => {
    if (open) {
      searchParams.set("settings", "true");
    } else {
      searchParams.delete("settings");
    }
    setSearchParams(searchParams);
  };
  const [activeSection, setActiveSection] = useState("general");
  const [settings, setSettings] = useState<SettingsState>({
    language: "english",
    notifySlowStartup: false,
  });

  const renderSettingsContent = () => {
    switch (activeSection) {
      case "general":
        return (
          <GeneralSettings
            settings={settings}
            setSettings={setSettings}
            direction={direction}
            onDirectionChange={onDirectionChange}
          />
        );
      case "editor":
        return <EditorSettings />;
      case "appearance":
        return <AppearanceSettings />;
      default:
        return <PlaceholderSettings section={activeSection} />;
    }
  };

  return (
    <Dialog
      open={searchParams.get("settings") === "true"}
      onOpenChange={(open) => handleSettingsToggle(open)}
    >
      <DialogContent className="max-w-6xl w-[95vw] h-[85vh] p-0 gap-0 overflow-hidden bg-card border-border">
        <DialogTitle className="sr-only">Settings</DialogTitle>

        <div dir={direction} className="flex h-full overflow-hidden">
          {/* Settings Sidebar */}
          <div className="w-56 shrink-0 border-e border-border bg-sidebar">
            <ScrollArea className="h-full p-0">
              <div className="py-1">
                {settingsSections.map((section) => (
                  <div key={section.label} className="mb-4">
                    <div className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      {t(section.label)}
                    </div>
                    <div className="space-y-0.5 px-2">
                      {section.items.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => setActiveSection(item.id)}
                          className={cn(
                            "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
                            activeSection === item.id
                              ? "bg-accent text-accent-foreground"
                              : "text-foreground/80 hover:bg-accent/50",
                          )}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Settings Content */}
          <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
            {/* Header with close button */}
            <div className="flex items-center justify-end p-1 border-b border-border shrink-0">
              <button
                onClick={() => handleSettingsToggle(false)}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <X className="h-5 w-5" />
                <span className="sr-only">Close</span>
              </button>
            </div>

            {/* Scrollable content */}
            <ScrollArea className="flex-1">
              <div className="p-6">{renderSettingsContent()}</div>
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// General Settings Panel
function GeneralSettings({
  settings,
  setSettings,
  direction,
  onDirectionChange,
}: {
  settings: SettingsState;
  setSettings: React.Dispatch<React.SetStateAction<SettingsState>>;
  direction: "ltr" | "rtl";
  onDirectionChange: (direction: "ltr" | "rtl") => void;
}) {
  return (
    <div className="space-y-8 max-w-3xl">
      {/* Update Section */}
      <UpdateSection />

      {/* Language */}
      <SettingRow
        title="Language"
        description="Change the display language."
        link={{ text: "Learn how to add a new language.", href: "#" }}
      >
        <Select
          value={settings.language}
          onValueChange={(value) =>
            setSettings((prev) => ({ ...prev, language: value }))
          }
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="english">English</SelectItem>
            <SelectItem value="spanish">Spanish</SelectItem>
            <SelectItem value="french">French</SelectItem>
            <SelectItem value="german">German</SelectItem>
            <SelectItem value="japanese">Japanese</SelectItem>
            <SelectItem value="arabic">Arabic</SelectItem>
            <SelectItem value="hebrew">Hebrew</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {/* Text Direction */}
      <SettingRow
        title="Text direction"
        description="Control the layout direction of the entire application."
      >
        <Select
          value={direction}
          onValueChange={(value) => onDirectionChange(value as "ltr" | "rtl")}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ltr">Left to Right</SelectItem>
            <SelectItem value="rtl">Right to Left</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {/* Help */}
      <SettingRow
        title="Help"
        description="Learn how to use the editor and get help from the community."
      >
        <Button variant="secondary">Open</Button>
      </SettingRow>

      {/* Account Section */}
      <div className="pt-4">
        <h2 className="text-lg font-semibold mb-4">Account</h2>

        <SettingRow
          title="Your account"
          description="You're not logged in right now. An account is only needed for Sync, Publish, and early access versions."
        >
          <div className="flex gap-2 shrink-0">
            <Button variant="secondary">Log in</Button>
            <Button variant="secondary">Sign up</Button>
          </div>
        </SettingRow>

        <SettingRow
          title="Commercial license"
          description="Help keep the editor 100% user-supported."
          link={{ text: "Learn more", href: "#" }}
        >
          <div className="flex gap-2 shrink-0">
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
              Activate
            </Button>
            <Button variant="secondary">Purchase</Button>
          </div>
        </SettingRow>
      </div>

      {/* Advanced Section */}
      <div className="pt-4">
        <h2 className="text-lg font-semibold mb-4">Advanced</h2>

        <SettingRow
          title="Notify if startup takes longer than expected"
          description="Diagnose issues with your app by seeing what is causing the app to load slowly."
        >
          <Switch
            checked={settings.notifySlowStartup}
            onCheckedChange={(checked) =>
              setSettings((prev) => ({ ...prev, notifySlowStartup: checked }))
            }
          />
        </SettingRow>
      </div>
    </div>
  );
}

// Editor Settings Panel
function EditorSettings() {
  const [spellcheck, setSpellcheck] = useState(true);
  const [lineNumbers, setLineNumbers] = useState(false);
  const [fontSize, setFontSize] = useState("16");

  return (
    <div className="space-y-8 max-w-3xl">
      <h2 className="text-lg font-semibold">Editor</h2>

      <SettingRow
        title="Spellcheck"
        description="Enable spellcheck in the editor."
      >
        <Switch checked={spellcheck} onCheckedChange={setSpellcheck} />
      </SettingRow>

      <SettingRow
        title="Show line numbers"
        description="Display line numbers in the editor gutter."
      >
        <Switch checked={lineNumbers} onCheckedChange={setLineNumbers} />
      </SettingRow>

      <SettingRow title="Font size" description="Set the editor font size.">
        <Select value={fontSize} onValueChange={setFontSize}>
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="12">12px</SelectItem>
            <SelectItem value="14">14px</SelectItem>
            <SelectItem value="16">16px</SelectItem>
            <SelectItem value="18">18px</SelectItem>
            <SelectItem value="20">20px</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </div>
  );
}

// Appearance Settings Panel
function AppearanceSettings() {
  const { setTheme, theme } = useTheme();
  const [accentColor, setAccentColor] = useState("purple");

  return (
    <div className="space-y-8 max-w-3xl">
      <h2 className="text-lg font-semibold">Appearance</h2>

      <SettingRow
        title="Theme"
        description="Choose a color theme for the interface."
      >
        <Select value={theme} onValueChange={setTheme}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dark">Dark</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow
        title="Accent color"
        description="Choose an accent color for highlights and interactive elements."
      >
        <Select value={accentColor} onValueChange={setAccentColor}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="purple">Purple</SelectItem>
            <SelectItem value="blue">Blue</SelectItem>
            <SelectItem value="green">Green</SelectItem>
            <SelectItem value="orange">Orange</SelectItem>
            <SelectItem value="pink">Pink</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </div>
  );
}

// Update Section Component
function UpdateSection() {
  const {
    status,
    progress,
    error,
    updateInfo,
    checkForUpdate,
    downloadAndInstall,
    relaunch,
  } = useUpdater();

  const currentVersion = __APP_VERSION__;

  const progressPercent =
    progress.total && progress.total > 0
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  return (
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-base font-medium">Version {currentVersion}</h3>

          {status === "idle" && (
            <p className="text-sm text-muted-foreground">
              Click to check for updates.
            </p>
          )}
          {status === "checking" && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking for updates...
            </p>
          )}
          {status === "up-to-date" && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
              You're on the latest version.
            </p>
          )}
          {status === "available" && updateInfo && (
            <p className="text-sm text-muted-foreground">
              Version {updateInfo.version} is available.
            </p>
          )}
          {status === "downloading" && (
            <div className="space-y-1.5">
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Downloading update...
                {progressPercent !== null && ` ${progressPercent}%`}
              </p>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{ width: `${progressPercent ?? 0}%` }}
                />
              </div>
            </div>
          )}
          {status === "ready" && (
            <p className="text-sm text-muted-foreground">
              Update downloaded. Restart to apply.
            </p>
          )}
          {status === "error" && (
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5" />
              {error ?? "Update check failed."}
            </p>
          )}
        </div>

        <div className="shrink-0">
          {(status === "idle" ||
            status === "up-to-date" ||
            status === "error") && (
            <Button variant="secondary" onClick={checkForUpdate}>
              Check for updates
            </Button>
          )}
          {status === "available" && (
            <Button
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={downloadAndInstall}
            >
              <Download className="h-4 w-4 mr-1.5" />
              Download
            </Button>
          )}
          {status === "ready" && (
            <Button
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={relaunch}
            >
              Restart
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Placeholder for other settings
function PlaceholderSettings({ section }: { section: string }) {
  const title =
    settingsSections.flatMap((s) => s.items).find((i) => i.id === section)
      ?.label || section;

  return (
    <div className="space-y-4 max-w-3xl">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-muted-foreground">
        Settings for {title.toLowerCase()} will appear here.
      </p>
    </div>
  );
}

// Reusable Setting Row Component
function SettingRow({
  title,
  description,
  link,
  children,
}: {
  title: string;
  description: string;
  link?: { text: string; href: string };
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border last:border-0">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground break-words">
          {description}
        </p>
        {link && (
          <a href={link.href} className="text-sm text-primary hover:underline">
            {link.text}
          </a>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
