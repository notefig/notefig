import React from "react";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  Settings,
  Palette,
  Keyboard,
  RefreshCw,
  GitBranch,
  Download,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  Shield,
} from "lucide-react";
import {
  updateTelemetryConsent,
  telemetryAvailable,
} from "@/telemetry/telemetry";
import { HarnessSettings } from "@/components/agent/harness-settings";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme-provider";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useSearchParamFlag } from "@/hooks/use-search-param-flag";
import { useWorkspaceTabsOptional } from "@/components/workspace-tabs-provider";
import {
  RELEASE_NOTES_TAB_ID,
  LAYOUT_PARAM,
  parseLayout,
} from "@/entities/tabs";
import { openFileInLayout } from "@/utils/dockable-layout";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAppUpdater,
  relaunchApp,
  startDownloadWithToastPromise,
} from "@/components/app-updater";

interface SettingsModalProps {
  direction: "ltr" | "rtl";
  onDirectionChange: (direction: "ltr" | "rtl") => void;
  onFocusTab: () => void;
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
    label: "generalSettings",
    items: [
      { id: "general", label: "General", icon: Settings },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "hotkeys", label: "Hotkeys", icon: Keyboard },
      { id: "privacy", label: "Privacy", icon: Shield },
    ],
  },
  {
    label: "agentSettings",
    items: [
      {
        id: "harnesses",
        label: "Harnesses",
        icon: Sparkles,
      },
    ],
  },
  {
    label: "corePlugins",
    items: [
      { id: "Git", label: "Git", icon: GitBranch },
      { id: "sync", label: "Sync", icon: RefreshCw },
    ],
  },
];

interface SettingsState {
  language: string;
  notifySlowStartup: boolean;
}

export function SettingsModal({
  direction,
  onDirectionChange,
  onFocusTab,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const { isOn: isSettingsOpen, setFlag: handleSettingsToggle } =
    useSearchParamFlag("settings", { replace: true });
  const handleCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    onFocusTab();
  };
  const [activeSection, setActiveSection] = useState("general");
  const [settings, setSettings] = useState<SettingsState>({
    language: "english",
    notifySlowStartup: false,
  });

  useHotkey({ key: ",", mod: true, shift: true }, () => {
    handleSettingsToggle(!isSettingsOpen);
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
      case "appearance":
        return <AppearanceSettings />;
      case "privacy":
        return <PrivacySettings />;
      case "harnesses":
        return <HarnessSettings />;
      default:
        return <PlaceholderSettings section={activeSection} />;
    }
  };

  return (
    <Dialog
      open={isSettingsOpen}
      onOpenChange={(open) => handleSettingsToggle(open)}
    >
      <DialogContent
        className="max-w-6xl w-[95vw] h-[85vh] p-0 gap-0 overflow-hidden bg-card border-border texture-surface"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>

        <div dir={direction} className="flex h-full overflow-hidden">
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

          <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
            <ScrollArea className="flex-1">
              <div className="p-6">{renderSettingsContent()}</div>
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
    <div className="space-y-2 max-w-3xl">
      <UpdateSection />

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

      <div className="pt-4">
        <h2 className="text-lg font-semibold mb-1">Advanced</h2>
        <DebugModeToggle />
      </div>
    </div>
  );
}

function AppearanceSettings() {
  const { setTheme, theme } = useTheme();
  const { setTheme: persistTheme } = useAppSettings();

  const handleThemeChange = (value: string) => {
    const t = value as "dark" | "light" | "system";
    setTheme(t);
    persistTheme(t);
  };

  return (
    <div className="space-y-2 max-w-3xl">
      <h2 className="text-lg font-semibold">Appearance</h2>

      <SettingRow
        title="Theme"
        description="Choose a color theme for the interface."
      >
        <Select value={theme} onValueChange={handleThemeChange}>
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
    </div>
  );
}

function UpdateSection() {
  const { t } = useTranslation();
  const { settings, setSetting, isReady } = useAppSettings();
  const workspaceTabs = useWorkspaceTabsOptional();
  const [, setUrlSearchParams] = useSearchParams();

  // One atomic URL write for close-modal + open-tab: two writers in the same
  // tick would each read the pre-update location and clobber the other.
  const openWhatsNew = () => {
    setUrlSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("settings");
      const nextLayout = openFileInLayout(parseLayout(next.get(LAYOUT_PARAM)), {
        tabId: RELEASE_NOTES_TAB_ID,
        intent: "new-tab",
      });
      next.set(LAYOUT_PARAM, JSON.stringify(nextLayout));
      return next;
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">Version {__APP_VERSION__}</h3>
          {workspaceTabs && (
            <button
              onClick={openWhatsNew}
              className="cursor-pointer text-sm text-primary hover:underline"
            >
              {t("releaseNotesTitle")}
            </button>
          )}
        </div>

        <div className="shrink-0">
          <UpdaterButton />
        </div>
      </div>

      <label className="flex cursor-pointer items-start gap-3 py-2 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70">
        <Checkbox
          className="mt-0.5"
          checked={settings.autoUpdateEnabled}
          disabled={!isReady}
          onCheckedChange={(checked) =>
            setSetting("autoUpdateEnabled", checked === true)
          }
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            {t("automaticUpdates")}
          </span>
          <span className="block text-sm text-muted-foreground">
            {t("automaticUpdatesDesc")}
          </span>
        </span>
      </label>
    </div>
  );
}

/** The single updater action button; its face reflects every updater state. */
function UpdaterButton() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const updater = useAppUpdater();
  const { status, progress, error, flow } = updater;

  const check = () => {
    updater.checkForUpdate();
  };

  switch (status) {
    case "checking":
      return (
        <Button variant="secondary" size="sm" disabled>
          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          {t("updaterChecking")}
        </Button>
      );
    case "up-to-date":
      return (
        <Button variant="secondary" size="sm" onClick={check}>
          <CheckCircle2 className="h-4 w-4 mr-1.5 text-green-500" />
          {t("updaterUpToDateShort")}
        </Button>
      );
    case "error":
      return (
        <Button
          variant="secondary"
          size="sm"
          title={error ?? t("updaterGenericError")}
          onClick={check}
        >
          <AlertCircle className="h-4 w-4 mr-1.5 text-destructive" />
          {t("updaterCheckForUpdates")}
        </Button>
      );
    case "available":
      return (
        <Button
          size="sm"
          onClick={() => {
            startDownloadWithToastPromise(queryClient);
          }}
        >
          <Download className="h-4 w-4 mr-1.5" />
          {flow === "refresh" ? t("updaterRefresh") : t("updaterDownload")}
        </Button>
      );
    case "downloading": {
      const percent =
        progress.total && progress.total > 0
          ? Math.round((progress.downloaded / progress.total) * 100)
          : null;
      return (
        <Button size="sm" disabled>
          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          {percent !== null ? `${percent}%` : t("updaterDownloading")}
        </Button>
      );
    }
    case "ready":
      return (
        <Button
          size="sm"
          onClick={() => {
            void relaunchApp(queryClient);
          }}
        >
          {t("updaterRestart")}
        </Button>
      );
    default:
      return (
        <Button variant="secondary" size="sm" onClick={check}>
          {t("updaterCheckForUpdates")}
        </Button>
      );
  }
}

function PrivacySettings() {
  const { t } = useTranslation();
  const { settings, setSetting } = useAppSettings();
  const available = telemetryAvailable();

  const applyConsent = (
    key: "crashReportingEnabled" | "analyticsEnabled",
    checked: boolean,
  ) => {
    const next = {
      crashEnabled:
        key === "crashReportingEnabled"
          ? checked
          : settings.crashReportingEnabled,
      analyticsEnabled:
        key === "analyticsEnabled" ? checked : settings.analyticsEnabled,
    };
    let installId = settings.telemetryInstallId;
    if ((next.crashEnabled || next.analyticsEnabled) && !installId) {
      installId = crypto.randomUUID();
      setSetting("telemetryInstallId", installId);
    }
    setSetting(key, checked);
    void updateTelemetryConsent({ ...next, installId });
  };

  return (
    <div className="space-y-2 max-w-3xl">
      <h2 className="text-lg font-semibold">{t("privacySettings")}</h2>

      {!available && (
        <p className="text-sm text-muted-foreground">
          {t("telemetryDisabledInBuild")}
        </p>
      )}

      <SettingRow
        title={t("telemetryCrashLabel")}
        description={t("telemetryCrashDescription")}
      >
        <Switch
          checked={available && settings.crashReportingEnabled}
          disabled={!available}
          onCheckedChange={(checked) =>
            applyConsent("crashReportingEnabled", checked)
          }
        />
      </SettingRow>

      <SettingRow
        title={t("telemetryAnalyticsLabel")}
        description={t("telemetryAnalyticsDescription")}
      >
        <Switch
          checked={available && settings.analyticsEnabled}
          disabled={!available}
          onCheckedChange={(checked) =>
            applyConsent("analyticsEnabled", checked)
          }
        />
      </SettingRow>
    </div>
  );
}

function DebugModeToggle() {
  const { isOn: isDebugActive, setFlag: handleToggle } = useSearchParamFlag(
    "debug",
    { replace: true },
  );

  return (
    <SettingRow
      title="Debug mode"
      description="Show the debug panel with route state, URL editor, and console capture."
    >
      <Switch checked={isDebugActive} onCheckedChange={handleToggle} />
    </SettingRow>
  );
}

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
    <div className="flex items-start justify-between gap-4 py-2">
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
