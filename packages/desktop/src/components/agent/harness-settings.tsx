import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
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
import { useHarnessSettingsRows } from "@/modules/agents/react";
import type { HarnessSettingsRow } from "@/modules/agents/harness-settings";
import { useDefaultHarness } from "@/hooks/use-harness-selection";
import { HarnessLogo } from "@/components/agent/harness-logo";
import {
  builtInHarness,
  definitionToForm,
  formToCustomEntry,
  formToOverride,
  newCustomHarnessId,
  validateHarnessForm,
  type HarnessFormErrors,
  type HarnessFormState,
} from "./harness-settings-form";
import { useCore } from "@notefig/core/react";

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
 * and an icon-only rescan. Editing expands that row inline into a
 * collapsible form (the rest of the list stays visible); the add-row
 * expands the same way for a new custom entry. Every edit goes through the
 * harness's handle (`core.harnesses.harness(id)`), so the pickers update
 * live.
 */
export function HarnessSettings() {
  const { t } = useTranslation();
  const { harnesses } = useCore();
  const rows = useHarnessSettingsRows();

  const { defaultHarness, setDefaultHarness } = useDefaultHarness();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmResetId, setConfirmResetId] = useState<string | null>(null);

  const rescan = async () => {
    setScanning(true);
    try {
      const results = await harnesses.rescan();
      if (results === null) toast.error(t("harnessRescanFailed"));
    } finally {
      setScanning(false);
    }
  };

  const toggleEnabled = (row: HarnessSettingsRow) =>
    void harnesses.harness(row.definition.id).setEnabled(!row.enabled);

  const saveRow = (
    row: HarnessSettingsRow,
    form: HarnessFormState,
  ): HarnessFormErrors | null => {
    const { definition, origin, enabled } = row;
    const { errors, parsed } = validateHarnessForm(form, {
      requireLabel: origin === "custom",
    });
    if (!parsed) return errors;
    // Saving re-checks the install: the verdict is keyed by harness id
    // alone, and would otherwise keep describing the executable the
    // harness pointed at before the edit (or, reverted, the override's).
    const harness = harnesses.harness(definition.id);
    if (origin === "custom") {
      const entry = formToCustomEntry(parsed, form, definition.id, enabled);
      void harness.saveCustom(entry);
    } else {
      void harness.saveOverride(
        formToOverride(
          parsed,
          builtInHarness(definition.id)!,
          enabled,
          naturalEnabled(row),
        ),
      );
    }
    setEditingId(null);
    return null;
  };

  const confirmResetRow = rows.find(
    (row) => row.definition.id === confirmResetId,
  );

  const confirmDeleteRow = rows.find(
    (row) => row.definition.id === confirmDeleteId,
  );

  return (
    <div className="space-y-4">
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
        {rows.map((row) => {
          const isEditing = editingId === row.definition.id;
          return (
            <div key={row.definition.id}>
              <HarnessRow
                row={row}
                isDefault={row.definition.id === defaultHarness.id}
                isEditing={isEditing}
                onMakeDefault={() => setDefaultHarness(row.definition.id)}
                onToggleEnabled={() => toggleEnabled(row)}
                onEdit={() =>
                  setEditingId(isEditing ? null : row.definition.id)
                }
                onDelete={() => setConfirmDeleteId(row.definition.id)}
              />
              {isEditing && (
                <div className="border-t border-border bg-muted/30 p-4">
                  <HarnessEditorFields
                    mode={row.origin === "custom" ? "custom" : "builtin"}
                    initialForm={definitionToForm(row.definition)}
                    onSave={(form) => saveRow(row, form)}
                    onCancel={() => setEditingId(null)}
                    onReset={
                      row.origin === "overridden"
                        ? () => setConfirmResetId(row.definition.id)
                        : undefined
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
        <div>
          <button
            type="button"
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50",
              editingId !== NEW_ENTRY_ID && "rounded-b-lg",
            )}
            onClick={() =>
              setEditingId(editingId === NEW_ENTRY_ID ? null : NEW_ENTRY_ID)
            }
          >
            <Plus className="size-4" />
            {t("harnessAdd")}
          </button>
          {editingId === NEW_ENTRY_ID && (
            <div className="rounded-b-lg border-t border-border bg-muted/30 p-4">
              <HarnessEditorFields
                mode="create"
                initialForm={EMPTY_FORM}
                onCancel={() => setEditingId(null)}
                onSave={(form) => {
                  const { errors, parsed } = validateHarnessForm(form, {
                    requireLabel: true,
                  });
                  if (!parsed) return errors;
                  const id = newCustomHarnessId();
                  // Saving checks its install: a found/not-found status
                  // right away.
                  void harnesses
                    .harness(id)
                    .saveCustom(formToCustomEntry(parsed, form, id, true));
                  setEditingId(null);
                  return null;
                }}
              />
            </div>
          )}
        </div>
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
                  void harnesses
                    .harness(confirmDeleteRow.definition.id)
                    .remove();
                }
                setConfirmDeleteId(null);
              }}
            >
              {t("harnessDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {confirmResetRow && (
        <ResetConfirmDialog
          row={confirmResetRow}
          open={confirmResetId === confirmResetRow.definition.id}
          onOpenChange={(open) =>
            setConfirmResetId(open ? confirmResetRow.definition.id : null)
          }
          onConfirm={() => {
            void harnesses
              .harness(confirmResetRow.definition.id)
              .saveOverride(null);
            setEditingId(null);
          }}
        />
      )}
    </div>
  );
}

/** Single-line row: status dot, logo, name (+origin chip), default check,
 *  and a … menu holding every control (mock: Edit / Set as default /
 *  Enable-Disable / Delete). */
export function HarnessRow({
  row,
  isDefault,
  isEditing,
  onMakeDefault,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  row: HarnessSettingsRow;
  isDefault: boolean;
  isEditing: boolean;
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
          discovery?.found ? "bg-success" : "bg-muted-foreground/30",
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
            {isEditing ? t("harnessCollapse") : t("harnessEdit")}
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
function HarnessEditorFields({
  mode,
  initialForm,
  onSave,
  onCancel,
  onReset,
}: {
  mode: "builtin" | "custom" | "create";
  initialForm: HarnessFormState;
  onSave: (form: HarnessFormState) => HarnessFormErrors | null;
  onCancel: () => void;
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
    <div className="space-y-4">
      <div className="space-y-4">
        <HarnessLabelField
          mode={mode}
          value={form.label}
          error={errors.label}
          onChange={(label) => patch({ label })}
        />

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

        <HarnessEnvField
          value={form.envText}
          errors={errors.env}
          onChange={(envText) => patch({ envText })}
        />

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

        <HarnessMcpField
          mode={mode}
          value={form.mcpOptIn}
          onChange={(mcpOptIn) => patch({ mcpOptIn })}
        />
      </div>

      <HarnessEditorButtons
        saveDisabled={touched && Object.keys(errors).length > 0}
        onSave={handleSave}
        onCancel={onCancel}
        onReset={onReset}
      />
    </div>
  );
}

/** Label is only editable off the builtin path; renders nothing there. */
function HarnessLabelField({
  mode,
  value,
  error,
  onChange,
}: {
  mode: "builtin" | "custom" | "create";
  value: string;
  error: HarnessFormErrors["label"];
  onChange: (label: string) => void;
}) {
  const { t } = useTranslation();
  if (mode === "builtin") return null;
  return (
    <Field label={t("harnessLabelField")}>
      <Input
        value={value}
        placeholder={t("harnessLabelPlaceholder")}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <FieldError text={t("harnessLabelRequired")} />}
    </Field>
  );
}

const ENV_ERROR_MESSAGE_KEY = {
  "no-equals": "harnessEnvErrorNoEquals",
  "bad-key": "harnessEnvErrorBadKey",
  duplicate: "harnessEnvErrorDuplicate",
} as const;

function HarnessEnvField({
  value,
  errors,
  onChange,
}: {
  value: string;
  errors: HarnessFormErrors["env"];
  onChange: (envText: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field label={t("harnessEnvField")}>
      <Textarea
        value={value}
        placeholder={t("harnessEnvPlaceholder")}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="font-mono text-xs"
      />
      {errors?.map((error) => (
        <FieldError
          key={`${error.kind}:${error.line}`}
          text={t(ENV_ERROR_MESSAGE_KEY[error.kind], { line: error.line })}
        />
      ))}
    </Field>
  );
}

/** The MCP opt-in only exists at create time; renders nothing otherwise. */
function HarnessMcpField({
  mode,
  value,
  onChange,
}: {
  mode: "builtin" | "custom" | "create";
  value: HarnessFormState["mcpOptIn"];
  onChange: (mcpOptIn: HarnessFormState["mcpOptIn"]) => void;
}) {
  const { t } = useTranslation();
  if (mode !== "create") return null;
  return (
    <Field label={t("harnessMcpField")}>
      <Select
        value={value}
        onValueChange={(next) => onChange(next as HarnessFormState["mcpOptIn"])}
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
      {value === "session-new" && (
        <p className="text-xs text-warning">{t("harnessMcpOptInWarning")}</p>
      )}
    </Field>
  );
}

function HarnessEditorButtons({
  saveDisabled,
  onSave,
  onCancel,
  onReset,
}: {
  saveDisabled: boolean;
  onSave: () => void;
  onCancel: () => void;
  onReset?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Button onClick={onSave} disabled={saveDisabled}>
        {t("harnessSave")}
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        {t("cancel")}
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
