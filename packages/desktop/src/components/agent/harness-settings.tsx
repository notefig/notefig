import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import {
  parseCustomHarnessEntries,
  parseHarnessDiscovery,
  parseHarnessOverrides,
  CustomHarnessEntrySchema,
  HarnessOverrideSchema,
  type CustomHarnessEntry,
  type HarnessOverride,
} from "@notefig/shared/agent";
import { Button } from "@notefig/ui/button";
import { Input } from "@notefig/ui/input";
import { Textarea } from "@notefig/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@notefig/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@notefig/ui/alert-dialog";
import { cn } from "@notefig/ui/utils";
import { useKv } from "@/utils/kv-store";
import {
  HARNESS_CUSTOM_KEY,
  HARNESS_DISCOVERY_KEY,
  HARNESS_OVERRIDES_KEY,
  HARNESS_SETTINGS_NAMESPACE,
  refreshHarnessDiscovery,
} from "@/agent/harness-discovery";
import { useDefaultHarness } from "@/hooks/use-harness-selection";
import { HarnessLogo } from "@notefig/ui/harness-logo";
import {
  builtInHarness,
  definitionToForm,
  deriveHarnessSettingsRows,
  formToCustomEntry,
  formToOverride,
  newCustomHarnessId,
  toggleCustomEnabled,
  toggleOverrideEnabled,
  validateHarnessForm,
  type HarnessFormErrors,
  type HarnessFormState,
  type HarnessSettingsRow,
} from "./harness-settings-form";

const NEW_ENTRY_ID = "__new__";

const EMPTY_FORM: HarnessFormState = {
  label: "",
  command: "",
  argsText: "",
  envText: "",
  probeCommand: "",
  resumeCommand: "",
  mcpOptIn: "none",
};

/** What the enabled switch would be with no explicit setting: found (or
 *  never probed) ⇒ on, affirmatively not found ⇒ off. */
function naturalEnabled(row: HarnessSettingsRow): boolean {
  return row.discovery?.found !== false;
}

/**
 * The SettingsModal "Harnesses" section: a unified list of every configured
 * harness — including ones the pickers hide — as single-line rows (status
 * dot, logo, name; controls behind a … menu), with an add-row at the bottom
 * and an icon-only rescan. Editing swaps the whole section for a form view
 * (back arrow returns). All state lives in the `harness-settings` KV
 * namespace, written through useKv so pickers update live.
 */
export function HarnessSettings() {
  const { t } = useTranslation();
  const kv = useKv<unknown>(HARNESS_SETTINGS_NAMESPACE);
  const rawOverrides = kv.get(HARNESS_OVERRIDES_KEY);
  const rawCustom = kv.get(HARNESS_CUSTOM_KEY);
  const rawDiscovery = kv.get(HARNESS_DISCOVERY_KEY);

  const { overrides, custom, rows } = useMemo(() => {
    const overrides = parseHarnessOverrides(rawOverrides);
    const custom = parseCustomHarnessEntries(rawCustom);
    return {
      overrides,
      custom,
      rows: deriveHarnessSettingsRows(
        overrides,
        custom,
        parseHarnessDiscovery(rawDiscovery),
      ),
    };
  }, [rawOverrides, rawCustom, rawDiscovery]);

  const { defaultHarness, setDefaultHarness } = useDefaultHarness();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmResetId, setConfirmResetId] = useState<string | null>(null);

  const writeOverrides = (next: Record<string, HarnessOverride>) =>
    kv.set(HARNESS_OVERRIDES_KEY, next);
  const writeCustom = (next: CustomHarnessEntry[]) =>
    kv.set(HARNESS_CUSTOM_KEY, next);

  const deleteOverride = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    writeOverrides(next);
  };

  const rescan = async () => {
    setScanning(true);
    try {
      const results = await refreshHarnessDiscovery(overrides, custom);
      if (results === null) toast.error(t("harnessRescanFailed"));
    } finally {
      setScanning(false);
    }
  };

  const toggleEnabled = (row: HarnessSettingsRow) => {
    if (row.origin === "custom") {
      writeCustom(toggleCustomEnabled(custom, row.definition.id, !row.enabled));
    } else {
      writeOverrides(
        toggleOverrideEnabled(
          overrides,
          row.definition.id,
          !row.enabled,
          naturalEnabled(row),
        ),
      );
    }
  };

  // Editor view (replaces the list): mock "Edit server" with back arrow.
  const editingRow =
    editingId !== null && editingId !== NEW_ENTRY_ID
      ? rows.find((row) => row.definition.id === editingId)
      : undefined;

  if (editingId === NEW_ENTRY_ID) {
    return (
      <HarnessEditorView
        title={t("harnessAdd")}
        mode="create"
        initialForm={EMPTY_FORM}
        onBack={() => setEditingId(null)}
        onSave={(form) => {
          const { errors, parsed } = validateHarnessForm(form, {
            requireLabel: true,
          });
          if (!parsed) return errors;
          const entry = formToCustomEntry(
            parsed,
            form,
            newCustomHarnessId(),
            true,
          );
          const checked = CustomHarnessEntrySchema.safeParse(entry);
          if (!checked.success) return errors;
          const nextCustom = [...custom, checked.data];
          writeCustom(nextCustom);
          setEditingId(null);
          // New entry gets a found/not-found status right away.
          void refreshHarnessDiscovery(overrides, nextCustom);
          return null;
        }}
      />
    );
  }

  if (editingRow) {
    const { definition, origin, enabled } = editingRow;
    const save = (form: HarnessFormState): HarnessFormErrors | null => {
      const { errors, parsed } = validateHarnessForm(form, {
        requireLabel: origin === "custom",
      });
      if (!parsed) return errors;
      if (origin === "custom") {
        const entry = formToCustomEntry(parsed, form, definition.id, enabled);
        const checked = CustomHarnessEntrySchema.safeParse(entry);
        if (!checked.success) return errors;
        const nextCustom = custom.map((existing) =>
          existing.id === definition.id ? checked.data : existing,
        );
        writeCustom(nextCustom);
        // Re-probe with the edited definition, exactly as the new-entry
        // path does. Discovery results are keyed by harness id alone, so
        // without this the stored verdict keeps describing the executable
        // the harness pointed at BEFORE the edit — the pickers and the
        // welcome screen would then report on the wrong binary.
        void refreshHarnessDiscovery(overrides, nextCustom);
      } else {
        const override = formToOverride(
          parsed,
          builtInHarness(definition.id)!,
          enabled,
          naturalEnabled(editingRow),
        );
        let nextOverrides: Record<string, HarnessOverride>;
        if (override === null) {
          deleteOverride(definition.id);
          // Reverting to the built-in re-probes too: the stored result may
          // describe the override's command, not the built-in's.
          nextOverrides = Object.fromEntries(
            Object.entries(overrides).filter(([id]) => id !== definition.id),
          );
        } else {
          const checked = HarnessOverrideSchema.safeParse(override);
          if (!checked.success) return errors;
          nextOverrides = { ...overrides, [definition.id]: checked.data };
          writeOverrides(nextOverrides);
        }
        void refreshHarnessDiscovery(nextOverrides, custom);
      }
      setEditingId(null);
      return null;
    };

    return (
      <>
        <HarnessEditorView
          title={t("harnessEditTitle")}
          mode={origin === "custom" ? "custom" : "builtin"}
          initialForm={definitionToForm(definition)}
          onBack={() => setEditingId(null)}
          onSave={save}
          onReset={
            origin === "overridden"
              ? () => setConfirmResetId(definition.id)
              : undefined
          }
        />
        <ResetConfirmDialog
          row={editingRow}
          open={confirmResetId === definition.id}
          onOpenChange={(open) =>
            setConfirmResetId(open ? definition.id : null)
          }
          onConfirm={() => {
            deleteOverride(definition.id);
            setEditingId(null);
          }}
        />
      </>
    );
  }

  const confirmDeleteRow = rows.find(
    (row) => row.definition.id === confirmDeleteId,
  );

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t("harnessSettingsTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("harnessSettingsDescription")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground"
          title={t("harnessRescan")}
          aria-label={t("harnessRescan")}
          onClick={() => void rescan()}
          disabled={scanning}
        >
          {scanning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </Button>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border">
        {rows.map((row) => (
          <HarnessRow
            key={row.definition.id}
            row={row}
            isDefault={row.definition.id === defaultHarness.id}
            onMakeDefault={() => setDefaultHarness(row.definition.id)}
            onToggleEnabled={() => toggleEnabled(row)}
            onEdit={() => setEditingId(row.definition.id)}
            onDelete={() => setConfirmDeleteId(row.definition.id)}
          />
        ))}
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded-b-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50"
          onClick={() => setEditingId(NEW_ENTRY_ID)}
        >
          <Plus className="size-4" />
          {t("harnessAdd")}
        </button>
      </div>

      <AlertDialog
        open={confirmDeleteRow !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("harnessDeleteConfirmTitle", {
                label: confirmDeleteRow?.definition.label ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("harnessDeleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeleteRow) {
                  writeCustom(
                    custom.filter(
                      (entry) => entry.id !== confirmDeleteRow.definition.id,
                    ),
                  );
                }
                setConfirmDeleteId(null);
              }}
            >
              {t("harnessDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Single-line row: status dot, logo, name (+origin chip), default check,
 *  and a … menu holding every control (mock: Edit / Set as default /
 *  Enable-Disable / Delete). */
function HarnessRow({
  row,
  isDefault,
  onMakeDefault,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  row: HarnessSettingsRow;
  isDefault: boolean;
  onMakeDefault: () => void;
  onToggleEnabled: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { definition, origin, enabled, discovery } = row;

  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          discovery?.found ? "bg-green-500" : "bg-muted-foreground/30",
        )}
      />
      <HarnessLogo
        harnessId={definition.id}
        className={cn("size-4", !enabled && "opacity-50")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm font-medium",
          !enabled && "text-muted-foreground",
        )}
      >
        {definition.label}
        {origin !== "builtin" && (
          <span className="ms-1.5 align-middle text-[0.625rem] font-normal text-muted-foreground">
            {origin === "custom"
              ? t("harnessOriginCustom")
              : t("harnessOriginOverridden")}
          </span>
        )}
      </span>

      {isDefault && <Check className="size-4 shrink-0 text-muted-foreground" />}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground"
            title={t("harnessRowActions")}
            aria-label={t("harnessRowActions")}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            {t("harnessEdit")}
          </DropdownMenuItem>
          {!isDefault && enabled && (
            <DropdownMenuItem onSelect={onMakeDefault}>
              {t("harnessMakeDefault")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onToggleEnabled}>
            {enabled ? t("harnessDisable") : t("harnessEnable")}
          </DropdownMenuItem>
          {origin === "custom" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={onDelete}
              >
                {t("harnessDelete")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ResetConfirmDialog({
  row,
  open,
  onOpenChange,
  onConfirm,
}: {
  row: HarnessSettingsRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("harnessResetConfirmTitle", { label: row.definition.label })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("harnessResetConfirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t("harnessResetDefaults")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Full-pane edit/create view (mock: "Edit server" — back arrow + title,
 * fields on a muted card, Save at the bottom). One object state
 * (HarnessFormState) with a single patch helper; formats live in
 * placeholders, not helper paragraphs. onSave returns errors to render
 * (null = saved; the caller navigates back).
 */
function HarnessEditorView({
  title,
  mode,
  initialForm,
  onSave,
  onBack,
  onReset,
}: {
  title: string;
  mode: "builtin" | "custom" | "create";
  initialForm: HarnessFormState;
  onSave: (form: HarnessFormState) => HarnessFormErrors | null;
  onBack: () => void;
  onReset?: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<HarnessFormState>(initialForm);
  const [errors, setErrors] = useState<HarnessFormErrors>({});
  const [touched, setTouched] = useState(false);

  const patch = (partial: Partial<HarnessFormState>) => {
    const next = { ...form, ...partial };
    setForm(next);
    // Once a save attempt surfaced errors, re-validate per keystroke so
    // errors clear as the user types.
    if (touched) {
      setErrors(
        validateHarnessForm(next, { requireLabel: mode !== "builtin" }).errors,
      );
    }
  };

  const handleSave = () => {
    setTouched(true);
    const validation = validateHarnessForm(form, {
      requireLabel: mode !== "builtin",
    });
    if (!validation.parsed) {
      setErrors(validation.errors);
      return;
    }
    const saveErrors = onSave(form);
    if (saveErrors) setErrors(saveErrors);
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          title={t("cancel")}
          aria-label={t("cancel")}
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>

      <div className="space-y-4 rounded-lg bg-muted/40 p-4">
        {mode !== "builtin" && (
          <Field label={t("harnessLabelField")}>
            <Input
              value={form.label}
              placeholder={t("harnessLabelPlaceholder")}
              onChange={(e) => patch({ label: e.target.value })}
            />
            {errors.label && <FieldError text={t("harnessLabelRequired")} />}
          </Field>
        )}

        <Field label={t("harnessCommandField")}>
          <Input
            value={form.command}
            placeholder={t("harnessCommandPlaceholder")}
            onChange={(e) => patch({ command: e.target.value })}
            className="font-mono text-xs"
          />
          {errors.command && <FieldError text={t("harnessCommandRequired")} />}
        </Field>

        <Field label={t("harnessArgsField")}>
          <Textarea
            value={form.argsText}
            placeholder={t("harnessArgsPlaceholder")}
            onChange={(e) => patch({ argsText: e.target.value })}
            rows={3}
            className="font-mono text-xs"
          />
        </Field>

        <Field label={t("harnessEnvField")}>
          <Textarea
            value={form.envText}
            placeholder={t("harnessEnvPlaceholder")}
            onChange={(e) => patch({ envText: e.target.value })}
            rows={3}
            className="font-mono text-xs"
          />
          {errors.env?.map((error) => (
            <FieldError
              key={`${error.kind}:${error.line}`}
              text={t(
                error.kind === "no-equals"
                  ? "harnessEnvErrorNoEquals"
                  : error.kind === "bad-key"
                    ? "harnessEnvErrorBadKey"
                    : "harnessEnvErrorDuplicate",
                { line: error.line },
              )}
            />
          ))}
        </Field>

        <Field label={t("harnessProbeField")}>
          <Input
            value={form.probeCommand}
            placeholder={t("harnessProbePlaceholder")}
            onChange={(e) => patch({ probeCommand: e.target.value })}
            className="font-mono text-xs"
          />
        </Field>

        <Field label={t("harnessResumeField")}>
          <Input
            value={form.resumeCommand}
            placeholder={t("harnessResumePlaceholder")}
            onChange={(e) => patch({ resumeCommand: e.target.value })}
            className="font-mono text-xs"
          />
        </Field>

        {mode === "create" && (
          <Field label={t("harnessMcpField")}>
            <Select
              value={form.mcpOptIn}
              onValueChange={(value) =>
                patch({ mcpOptIn: value as HarnessFormState["mcpOptIn"] })
              }
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("harnessMcpNone")}</SelectItem>
                <SelectItem value="session-new">
                  {t("harnessMcpSessionNew")}
                </SelectItem>
              </SelectContent>
            </Select>
            {form.mcpOptIn === "session-new" && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                {t("harnessMcpOptInWarning")}
              </p>
            )}
          </Field>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          onClick={handleSave}
          disabled={touched && Object.keys(errors).length > 0}
        >
          {t("harnessSave")}
        </Button>
        {onReset && (
          <Button
            variant="ghost"
            className="ms-auto text-muted-foreground"
            onClick={onReset}
          >
            {t("harnessResetDefaults")}
          </Button>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function FieldError({ text }: { text: string }) {
  return <p className="text-xs text-destructive">{text}</p>;
}
