import { useEffect, useRef, useState } from "react";
import {
  Book,
  FolderOpen,
  Github,
  Monitor,
  Moon,
  Settings,
  Sun,
} from "lucide-react";
import { Button } from "@notefig/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import { ScrollArea } from "@notefig/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@notefig/ui/dialog";
import { cn } from "@notefig/ui/utils";
import type { HarnessAvailability } from "@notefig/shared/agent";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { platformAdapter } from "@/adapters";
import { FsError } from "@/adapters/platform-adapter.interface";
import Logo, { PlainLogo } from "@/components/logo";
import {
  SettingsModal,
  DEFAULT_SETTINGS_SECTION,
} from "@/components/editor/settings-modal";
import { useTheme } from "@/components/theme-provider";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useProbedHarnesses } from "@/hooks/use-harness-selection";
import {
  useRecentProjects,
  type RecentProjectDisplay,
} from "@/hooks/use-recent-projects";
import { pickDirectory } from "@/utils/fs";
import { renderMarkdownHtml } from "@/utils/markdown-html";
import { isWeb } from "@/utils/platform";
import { latestReleaseBody, latestReleaseTitle } from "@/utils/release-notes";
import { ReleaseNotesDocument } from "./release-notes-tab";
import { DebugPanel } from "./debug-panel";

function openExternalLink(url: string) {
  platformAdapter.ui.openExternal(url);
}

/**
 * Route anchor clicks inside injected markdown to the platform opener.
 * `renderMarkdownHtml` runs markdown-it with `linkify: true`, so a bundled
 * release note can contain anchors even when its author wrote a bare URL —
 * and a plain anchor click in the desktop webview navigates the APP out of
 * existence rather than opening a browser. Delegated on the container
 * because the markup is set via dangerouslySetInnerHTML and has no
 * elements of ours to bind to.
 */
function handleMarkdownLinkClick(event: React.MouseEvent<HTMLElement>) {
  const anchor = (event.target as HTMLElement).closest("a");
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute("href");
  if (href) openExternalLink(href);
}

/** Icon-button footprint for the rail's utility row — one size for the
 *  links, the theme menu and settings, so they read as a single strip. */
const RAIL_ICON_BUTTON =
  "size-6 text-muted-foreground hover:text-foreground lg:size-8";

function ThemeToggle() {
  const { t } = useTranslation();
  const { setTheme } = useTheme();
  const { setTheme: persistTheme } = useAppSettings();

  const handleThemeChange = (theme: "light" | "dark" | "system") => {
    setTheme(theme);
    persistTheme(theme);
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className={RAIL_ICON_BUTTON}>
              <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
              <span className="sr-only">{t("toggleTheme")}</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {t("toggleTheme")}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handleThemeChange("light")}>
          <Sun className="mr-2 size-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleThemeChange("dark")}>
          <Moon className="mr-2 size-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleThemeChange("system")}>
          <Monitor className="mr-2 size-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const AVAILABILITY_DOT: Record<HarnessAvailability, string> = {
  found: "bg-emerald-500",
  missing: "bg-muted-foreground/30",
  // "We haven't checked" is not "it's missing": an unknown row keeps the
  // dot's column so the list stays aligned, but paints nothing in it rather
  // than showing a grey dot that reads as absent. This is the state on
  // Windows (the probe script is POSIX) and for the first frames of every
  // launch, before the startup scan lands.
  unknown: "bg-transparent",
};

/** Geometry shared by every harness row, including the Configure row that
 *  closes the list — same dot column, same icon column, same rhythm. */
const HARNESS_ROW =
  "flex items-center gap-1.5 text-left text-xs lg:w-full lg:gap-2";

/** An icon button in the rail's utility strip, with its label as a
 *  tooltip — the strip is icon-only, so the name has to live somewhere. */
function RailIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClick}
          className={RAIL_ICON_BUTTON}
        >
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Readiness list for the configured harnesses — purely what the startup
 * discovery scan already probed (`useProbedHarnesses`), so rendering it
 * costs a KV read and never spawns anything. State is carried by the dot
 * and the text weight rather than a label per row, which keeps the rail
 * scannable.
 *
 * It deliberately reports nothing about model, context or quota. Those are
 * session-scoped facts in ACP: a model name only exists once `session/new`
 * has run against a real workspace, and usage only after a turn. Claiming
 * them here would mean minting a throwaway session per harness on every
 * launch — see docs/architecture/welcome-redesign-spike.md.
 */
function HarnessPanel() {
  const { t } = useTranslation();
  const probed = useProbedHarnesses();

  return (
    <section>
      {probed.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("harnessNoneConfigured")}
        </p>
      ) : (
        <ul className="flex flex-wrap items-center gap-x-2 gap-y-1.5 lg:block lg:space-y-1.5">
          {probed.map(({ harness, availability }) => (
            <li
              key={harness.id}
              // A missing harness is still worth listing (it names what you
              // could install), just visibly de-emphasised.
              className={cn(
                HARNESS_ROW,
                availability === "found"
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
              data-availability={availability}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  AVAILABILITY_DOT[availability],
                )}
              />
              <HarnessLogo harnessId={harness.id} className="size-3" />
              <span className="truncate">{harness.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The current release's notes. The markdown is rendered as markdown —
 * the document's own list structure, bold lead-ins and inline code all
 * survive — and the rail is kept small purely with CSS: entries past the
 * third are hidden, each entry is clamped to one line, and a max height
 * backstops any release that isn't shaped like a list at all.
 *
 * Build-time content from our own repo (see release-notes.ts) through the
 * same `html: false` renderer the chat uses, so there is no raw HTML to
 * sanitize. Renders nothing when a build ships without notes.
 */
function ReleaseNotesPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!latestReleaseTitle || !latestReleaseBody) return null;

  return (
    <section className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 lg:block">
      <h2 className="text-xs font-medium text-foreground lg:mb-2">
        <button
          onClick={() => setOpen(true)}
          className="underline underline-offset-2 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:text-muted-foreground lg:no-underline lg:hover:text-foreground"
        >
          v{__APP_VERSION__}
        </button>
      </h2>
      <div
        className={cn(
          // The preview earns its place in the rail. Narrow, it would be
          // six more truncated lines under everything else, so the version
          // link carries it alone.
          "hidden max-h-48 overflow-hidden text-xs leading-snug text-muted-foreground lg:block",
          // Preflight strips list-style, so the markers are put back
          // explicitly. One line per entry via `truncate` and NOT
          // `line-clamp-1`: line-clamp sets display:-webkit-box, which
          // overrides display:list-item and makes the browser stop painting
          // markers altogether. truncate leaves the li a list item, so these
          // are the real markers rather than a pseudo-element standing in
          // for them. (A nested list inside a shown entry is clipped by the
          // same rule — the link below covers it.)
          "[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:list-inside [&_ol]:list-inside",
          "[&_ul]:space-y-1 [&_ol]:space-y-1",
          "[&_li]:truncate [&_li]:marker:text-muted-foreground/50",
          // Keep the top six entries; the link below covers the rest. The
          // count lives in the selector rather than a constant because
          // Tailwind generates these classes at build time.
          "[&>ul>li:nth-child(n+7)]:hidden [&>ol>li:nth-child(n+7)]:hidden",
          "[&_p]:line-clamp-2 [&_p]:mb-1",
          "[&_strong]:font-medium [&_strong]:text-foreground",
          "[&_code]:font-mono",
          "[&_a]:underline [&_a]:underline-offset-2",
        )}
        onClick={handleMarkdownLinkClick}
        dangerouslySetInnerHTML={{
          __html: renderMarkdownHtml(latestReleaseBody),
        }}
      />
      <button
        onClick={() => setOpen(true)}
        className="hidden text-xs text-muted-foreground underline underline-offset-2 lg:mt-2 lg:block transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
      >
        {t("releaseNotesLink")}
      </button>

      {/* The same document the in-workspace tab renders — one component,
          two hosts (see ReleaseNotesDocument). The welcome screen has no
          workspace to open a tab in, so it hosts the notes in a modal. */}
      <Dialog open={open} onOpenChange={setOpen}>
        {/* flex, not the base grid: a grid row sizes to its content, so the
            document would grow past max-h and spill out of the panel
            instead of scrolling inside it. */}
        <DialogContent className="flex max-h-[80vh] flex-col gap-0 sm:max-w-3xl">
          {/* The notes are a self-titled document (see release-notes.ts), so
              its own `# ` heading is the visible title — this one exists
              only to give the dialog an accessible name. */}
          <DialogHeader className="sr-only">
            <DialogTitle>{latestReleaseTitle}</DialogTitle>
          </DialogHeader>
          <ReleaseNotesDocument className="prose prose-sm dark:prose-invert min-h-0 max-w-none flex-1 overflow-y-auto pr-2 outline-none" />
        </DialogContent>
      </Dialog>
    </section>
  );
}

function RecentProjectRow({
  project,
  onOpen,
}: {
  project: RecentProjectDisplay;
  onOpen: (path: string) => void;
}) {
  return (
    <button
      onClick={() => onOpen(project.path)}
      // The ring is painted inside the row: drawn outside (the default) it
      // is clipped by the ScrollArea and the column's overflow-hidden, which
      // is what made focused cards look sheared off.
      className="group flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-accent focus-visible:border-primary focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted dark:rounded-none dark:bg-transparent">
        <PlainLogo size="0.875rem" fill="var(--logo)" className="block dark:hidden" />
        <Logo size="1.75rem" className="hidden dark:block" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-xs font-medium text-foreground">
          {project.name}
        </h3>
        <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">
          {project.path}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[0.6875rem] text-muted-foreground">
          {project.lastModified}
        </p>
      </div>
    </button>
  );
}

export function Welcome() {
  const [loading, setLoading] = useState(false);
  const [, setUrlSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const { addRecentProject, recentProjects } = useRecentProjects();

  useEffect(() => {
    const timer = setTimeout(() => {
      openButtonRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const handleOpenWorkspace = async () => {
    setLoading(true);
    try {
      const selectedPath = await pickDirectory("Select a folder");
      if (selectedPath) {
        addRecentProject(selectedPath);
        navigate(`/${encodeURIComponent(selectedPath)}`);
      }
    } catch (error) {
      // null means cancel; a throw means the browser denied the picker.
      if (error instanceof FsError && error.type === "permission_denied") {
        toast.error(t("pickerPermissionDenied"));
      } else {
        throw error;
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOpenProject = (path: string) => {
    addRecentProject(path);
    navigate(`/${encodeURIComponent(path)}`);
  };

  const handleOpenSettings = () => {
    setUrlSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("settings", DEFAULT_SETTINGS_SECTION);
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div className="texture-surface relative flex h-full flex-col overflow-hidden bg-background">
      <DebugPanel />

      <div className="relative z-0 grid flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] overflow-hidden lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-1">
        {/* Left: the welcome moment, the one primary action, and recents. */}
        <div className="flex min-h-0 flex-col overflow-hidden px-7 pb-7 pt-10 lg:px-10 lg:pt-12">
          <div className="shrink-0">
            <h1 className="font-serif text-6xl font-bold italic leading-none tracking-tight text-foreground md:text-6xl">
              {t("welcomeTitleHighlight")}
            </h1>
            <p className="mt-3 max-w-sm text-xs leading-relaxed text-muted-foreground">
              {t("welcomeDescription")}
            </p>

            <div className="mt-5">
              <Button
                ref={openButtonRef}
                onClick={handleOpenWorkspace}
                disabled={loading}
                size="sm"
                className="gap-2"
              >
                <FolderOpen className="size-4" />
                {loading ? t("opening") : t("newDocument")}
              </Button>
            </div>
          </div>

          <h2 className="mb-2.5 mt-8 shrink-0 text-xs font-medium text-foreground">
            {t("recentWorkspaces")}
          </h2>

          <ScrollArea className="-mr-4 min-h-0 flex-1">
            <div className="space-y-1.5 pr-4">
              {recentProjects.length > 0 ? (
                recentProjects.map((project) => (
                  <RecentProjectRow
                    key={project.path}
                    project={project}
                    onOpen={handleOpenProject}
                  />
                ))
              ) : (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
                  <p className="text-xs text-muted-foreground">
                    {t("noRecentProjects")}
                  </p>
                  <p className="mt-1 text-[0.6875rem] text-muted-foreground">
                    {t("openWorkspaceHint")}
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Right rail: everything that isn't the main action. No ground of
            its own, and the divider is a short inset rule rather than a
            full-height border, so the page reads as one surface. Scrolling
            lives on the harness list — the rule is painted on this element
            and would otherwise drift with the content. */}
        <aside className="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-5 lg:min-h-0 lg:flex-col lg:flex-nowrap lg:items-stretch lg:px-5 lg:pb-7 lg:pt-12 lg:before:absolute lg:before:inset-y-12 lg:before:left-0 lg:before:w-px lg:before:bg-border">
          {/* Install checks can't run in the browser — `runShellCommand`
              throws there and harnesses live on the remote worker, not this
              machine — so the readiness list is desktop-only rather than a
              column of rows that can never resolve. */}
          {/* `contents` below lg: this wrapper exists to make the rail a
              scrolling column, but in the narrow footer it would be a flex
              item of its own and push the notes onto a second line. Removing
              it from layout lets the harness chips, the notes link and the
              icon strip share one row. */}
          <div className="contents lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:gap-6 lg:overflow-y-auto">
            {!isWeb() && <HarnessPanel />}
            <ReleaseNotesPanel />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-0.5 lg:ml-0 lg:mt-4 lg:justify-end">
            <RailIconButton
              label={t("documentation")}
              onClick={() => openExternalLink("https://notefig.com/docs")}
            >
              <Book className="size-4" />
            </RailIconButton>
            <RailIconButton
              label="GitHub"
              onClick={() =>
                openExternalLink("https://github.com/notefig/notefig")
              }
            >
              <Github className="size-4" />
            </RailIconButton>
            <ThemeToggle />
            <RailIconButton label={t("settings")} onClick={handleOpenSettings}>
              <Settings className="size-4" />
            </RailIconButton>
          </div>
        </aside>
      </div>

      <SettingsModal
        direction="ltr"
        onDirectionChange={() => {}}
        onFocusTab={() => {}}
      />
    </div>
  );
}
