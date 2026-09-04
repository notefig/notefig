import React from "react";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@notefig/ui/dialog";
import { Switch } from "@notefig/ui/switch";
import { Checkbox } from "@notefig/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@notefig/ui/select";
import { Button } from "@notefig/ui/button";
import { ScrollArea } from "@notefig/ui/scroll-area";
import { cn } from "@notefig/ui/utils";
import { useHotkey, formatForDisplay } from "@tanstack/react-hotkeys";
import {
  Settings,
  Palette,
  Keyboard,
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
import {
  useSearchParamFlag,
  useSearchParamValue,
} from "@/hooks/use-search-param-flag";
import { useScrollSpy } from "./use-scroll-spy";
import {
  HOTKEY_CATALOG,
  HOTKEY_GROUPS,
  type HotkeyEntry,
} from "./hotkey-catalog";
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

interface SettingsSectionDefinition {
  id: string;
  label: string;
  icon: React.ElementType;
}

/**
 * Every section, in the order they stack inside the one scroll container. The
 * left rail is an index into this list, not a router.
 */
const SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "hotkeys", label: "Hotkeys", icon: Keyboard },
  { id: "harnesses", label: "Harnesses", icon: Sparkles },
  { id: "privacy", label: "Privacy", icon: Shield },
];

export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0].id;

/**
 * `?settings=<section>` carries both facts: absent means the modal is closed,
 * present names the open section. An unknown value still opens, on General.
 */
function resolveSection(param: string | null) {
  return SETTINGS_SECTIONS.some((section) => section.id === param)
    ? (param as string)
    : DEFAULT_SETTINGS_SECTION;
}

interface SettingsState {
  language: string;
}

export function SettingsModal({
  direction,
  onDirectionChange,
  onFocusTab,
}: SettingsModalProps) {
  const { value: sectionParam, setValue: setSectionParam } =
    useSearchParamValue("settings", { replace: true });
  const isSettingsOpen = sectionParam !== null;
  const targetSection = resolveSection(sectionParam);

  const handleCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    onFocusTab();
  };
  const [settings, setSettings] = useState<SettingsState>({
    language: "english",
  });

  const { setContainer, activeId, scrollToSection } = useScrollSpy();

  useHotkey({ key: ",", mod: true, shift: true }, () => {
    setSectionParam(isSettingsOpen ? null : DEFAULT_SETTINGS_SECTION);
  });

  // URL -> scroll, on entry only: opening the modal, or a section arriving in
  // the URL from outside, jumps there. Deliberately not re-run on `activeId`:
  // a smooth scroll reports every section it passes, and re-scrolling to the
  // target on each of those would restart the animation forever.
  const appliedSection = useRef<string | null>(null);
  useEffect(() => {
    if (!isSettingsOpen) {
      appliedSection.current = null;
      return;
    }
    if (appliedSection.current === targetSection) return;
    // The first scroll of a freshly opened dialog is a jump, not a glide.
    const behavior = appliedSection.current === null ? "auto" : "smooth";
    if (scrollToSection(targetSection, behavior)) {
      appliedSection.current = targetSection;
    }
  }, [isSettingsOpen, targetSection, scrollToSection]);

  // Scroll -> URL: the section you are reading is the section in the URL.
  // `replace` so a scroll through the page leaves no history to walk back.
  // Claiming `appliedSection` here is what keeps this from feeding back into
  // the effect above as if the URL had changed from outside.
  useEffect(() => {
    if (!isSettingsOpen || !activeId || activeId === sectionParam) return;
    appliedSection.current = activeId;
    setSectionParam(activeId);
  }, [isSettingsOpen, activeId, sectionParam, setSectionParam]);

  return (
    <Dialog
      open={isSettingsOpen}
      onOpenChange={(open) =>
        setSectionParam(open ? DEFAULT_SETTINGS_SECTION : null)
      }
    >
      <DialogContent
        className="max-w-6xl w-[95vw] h-[85vh] p-0 gap-0 overflow-hidden bg-card border-border texture-surface focus:outline-none focus-visible:outline-none"
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>

        <div dir={direction} className="flex h-full overflow-hidden">
          <div className="w-56 shrink-0 border-e border-border bg-sidebar">
            <ScrollArea className="h-full p-0">
              <div className="space-y-0.5 px-2 py-4">
                {SETTINGS_SECTIONS.map((section) => (
                  <SettingsIndexItem
                    key={section.id}
                    section={section}
                    active={activeId === section.id}
                    onSelect={() => scrollToSection(section.id)}
                  />
                ))}
              </div>
            </ScrollArea>
          </div>

          <ScrollArea ref={setContainer} className="flex-1 min-w-0 px-6">
            <SettingsSection id="general" title="General">
              <GeneralSettings
                settings={settings}
                setSettings={setSettings}
                direction={direction}
                onDirectionChange={onDirectionChange}
              />
            </SettingsSection>

            <SettingsSection id="appearance" title="Appearance">
              <AppearanceSettings />
            </SettingsSection>

            <SettingsSection id="hotkeys">
              <HotkeysSettings />
            </SettingsSection>

            <SettingsSection id="harnesses">
              <HarnessSettings />
            </SettingsSection>

            <SettingsSection id="privacy" last>
              <PrivacySettings />
            </SettingsSection>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsIndexItem({
  section,
  active,
  onSelect,
}: {
  section: SettingsSectionDefinition;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <button
      ref={ref}
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
        "focus:outline-none focus-visible:outline-none",
        active
          ? "bg-accent text-accent-foreground"
          : "text-foreground/80 hover:bg-accent/50",
      )}
    >
      <section.icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{section.label}</span>
    </button>
  );
}

/**
 * One anchor in the settings document. `title` is optional: sections whose
 * heading carries its own controls (harnesses, with its rescan button) render
 * their own.
 */
function SettingsSection({
  id,
  title,
  last,
  children,
}: {
  id: string;
  title?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      data-settings-section={id}
      className={cn(
        "space-y-2 py-6",
        // The final section stretches to a full viewport height so that it,
        // too, can scroll up to the activation line and light up in the index.
        last ? "min-h-full" : "border-b border-border",
      )}
    >
      {title && <h2 className="text-lg font-semibold">{title}</h2>}
      {children}
    </section>
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
    <div className="space-y-2">
      <UpdateSection />

      <SettingRow title="Language" description="Change the display language.">
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

      <ScratchpadOnStartupToggle />

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
    <div className="space-y-2">
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

/**
 * Read-only reference for the shortcuts this version ships with. Rebinding
 * lands in a later release, when `HOTKEY_CATALOG` becomes the registry the
 * `useHotkey()` call sites read from.
 */
function HotkeysSettings() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("keyboardShortcuts")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("hotkeysDescription")}
        </p>
      </div>

      {HOTKEY_GROUPS.map((group) => {
        const entries = HOTKEY_CATALOG.filter(
          (entry) => entry.group === group.id,
        );
        if (entries.length === 0) return null;

        return (
          <div key={group.id} className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t(group.labelKey)}
            </h3>
            <div className="divide-y divide-border rounded-lg border border-border">
              {entries.map((entry) => (
                <HotkeyRow key={entry.id} entry={entry} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HotkeyRow({ entry }: { entry: HotkeyEntry }) {
  const { t } = useTranslation();
  const chord = entry.bindingEnd
    ? `${formatForDisplay(entry.binding)} – ${formatForDisplay(entry.bindingEnd)}`
    : formatForDisplay(entry.binding);

  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2">
      <span className="min-w-0 truncate text-sm">
        {t(`hotkeyLabels.${entry.labelKey}`)}
      </span>
      <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
        {chord}
      </kbd>
    </div>
  );
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
    <div className="space-y-2">
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

function ScratchpadOnStartupToggle() {
  const { t } = useTranslation();
  const { settings, setSetting, isReady } = useAppSettings();

  return (
    <SettingRow
      title={t("scratchpadOnStartup")}
      description={t("scratchpadOnStartupDesc")}
    >
      <Switch
        checked={settings.scratchpadOnStartup}
        disabled={!isReady}
        onCheckedChange={(checked) =>
          setSetting("scratchpadOnStartup", checked)
        }
      />
    </SettingRow>
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
