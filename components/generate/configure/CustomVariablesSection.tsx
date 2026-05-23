"use client";

import { useState, useRef, useEffect } from "react";
import { useGenerationStore } from "@/store/generation-store";
import type {
  CustomVariable,
  CustomVariableValues,
  PersonaFieldKey,
  StringValueOption,
} from "@/lib/profiles/types";
import { PERSONA_FIELD_OPTIONS } from "@/lib/profiles/types";
import {
  rebalanceToTotal,
  removeKeyAndRedistribute,
  distributeEvenly,
  type WeightedItem,
} from "@/lib/utils/sum-to-total";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import {
  AlertCircle,
  Boxes,
  Edit2,
  Info,
  Plus,
  Trash2,
  User,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

interface VariablePreset {
  label: string;
  apiIdentifier: string;
  description: string;
  options: StringValueOption[];
}

const PRESETS: VariablePreset[] = [
  {
    label: "Products",
    apiIdentifier: "sys_products",
    description: "Weighted product list",
    options: [
      { text: "Product A", weight: 34 },
      { text: "Product B", weight: 33 },
      { text: "Product C", weight: 33 },
    ],
  },
  {
    label: "Stores",
    apiIdentifier: "sys_stores",
    description: "Store/location names",
    options: [
      { text: "Store 1", weight: 50 },
      { text: "Store 2", weight: 50 },
    ],
  },
  {
    label: "Customer Tier",
    apiIdentifier: "customer_tier",
    description: "Enterprise / Growth / Starter split",
    options: [
      { text: "Enterprise", weight: 40 },
      { text: "Growth", weight: 35 },
      { text: "Starter", weight: 25 },
    ],
  },
  {
    label: "Lifecycle Stage",
    apiIdentifier: "lifecycle_stage",
    description: "Customer lifecycle segment",
    options: [
      { text: "Active", weight: 50 },
      { text: "Onboarding", weight: 30 },
      { text: "At Risk", weight: 20 },
    ],
  },
  {
    label: "Region",
    apiIdentifier: "region",
    description: "Geographic region",
    options: [
      { text: "North America", weight: 40 },
      { text: "EMEA", weight: 35 },
      { text: "APAC", weight: 25 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface StringOption {
  id: string;
  text: string;
  weight: number;
}

type VariableType = "STRING" | "NUMBER" | "DATE" | "PERSONA";

/** Surface labels + tooltips for each type — the order is also the render
 *  order in the segmented control. */
const TYPE_OPTIONS: Array<{ id: VariableType; tooltip: string }> = [
  { id: "STRING", tooltip: "Weighted list of static text options." },
  { id: "NUMBER", tooltip: "Numeric value — fixed or random within a range." },
  { id: "DATE", tooltip: "Date — relative window from submission or an absolute range." },
  {
    id: "PERSONA",
    tooltip:
      "Maps this variable to a persona field — each response gets that persona's actual value (e.g. first name, email).",
  },
];

interface VariableForm {
  label: string;
  apiIdentifier: string;
  apiIdentifierTouched: boolean;
  type: VariableType;
  // STRING
  stringOptions: StringOption[];
  stringOptionDraft: string;
  // NUMBER
  numberMode: "range" | "static";
  numberMin: string;
  numberMax: string;
  numberStatic: string;
  // DATE
  dateMode: "relative" | "range";
  dateRelativeDays: string;
  dateStart: string;
  dateEnd: string;
  // PERSONA — empty string when no field is selected yet.
  personaField: PersonaFieldKey | "";
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const EMPTY_FORM: VariableForm = {
  label: "",
  apiIdentifier: "",
  apiIdentifierTouched: false,
  type: "STRING",
  stringOptions: [],
  stringOptionDraft: "",
  numberMode: "range",
  numberMin: "1",
  numberMax: "100",
  numberStatic: "0",
  dateMode: "relative",
  dateRelativeDays: "30",
  dateStart: daysAgoStr(30),
  dateEnd: todayStr(),
  personaField: "",
};

function deriveIdentifier(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 35);
}

function presetToForm(preset: VariablePreset): VariableForm {
  return {
    ...EMPTY_FORM,
    label: preset.label,
    apiIdentifier: preset.apiIdentifier,
    apiIdentifierTouched: true,
    type: "STRING",
    stringOptions: preset.options.map((o) => ({
      id: crypto.randomUUID(),
      text: o.text,
      weight: o.weight,
    })),
  };
}

function variableToForm(v: CustomVariable): VariableForm {
  const base: VariableForm = {
    ...EMPTY_FORM,
    label: v.label,
    apiIdentifier: v.apiIdentifier,
    apiIdentifierTouched: true,
    type: v.type,
  };
  if (v.values.kind === "string") {
    return {
      ...base,
      stringOptions: v.values.config.options.map((o) => ({
        id: crypto.randomUUID(),
        text: o.text,
        weight: o.weight,
      })),
    };
  }
  if (v.values.kind === "number") {
    const c = v.values.config;
    return {
      ...base,
      numberMode: c.mode,
      numberMin: String(c.min ?? 1),
      numberMax: String(c.max ?? 100),
      numberStatic: String(c.staticValue ?? 0),
    };
  }
  if (v.values.kind === "date") {
    const c = v.values.config;
    return {
      ...base,
      dateMode: c.mode,
      dateRelativeDays: String(c.relativeDays ?? 30),
      dateStart: c.start ? new Date(c.start).toISOString().slice(0, 10) : daysAgoStr(30),
      dateEnd: c.end ? new Date(c.end).toISOString().slice(0, 10) : todayStr(),
    };
  }
  if (v.values.kind === "persona_field") {
    return {
      ...base,
      personaField: v.values.config.field,
    };
  }
  return base;
}

function formToValues(form: VariableForm): CustomVariableValues {
  if (form.type === "STRING") {
    return {
      kind: "string",
      config: { options: form.stringOptions.map((o) => ({ text: o.text, weight: o.weight })) },
    };
  }
  if (form.type === "NUMBER") {
    return {
      kind: "number",
      config: {
        mode: form.numberMode,
        min: form.numberMode === "range" ? parseFloat(form.numberMin) : undefined,
        max: form.numberMode === "range" ? parseFloat(form.numberMax) : undefined,
        staticValue:
          form.numberMode === "static" ? parseFloat(form.numberStatic) : undefined,
      },
    };
  }
  if (form.type === "PERSONA") {
    // Validation guarantees personaField is set; the fallback to "firstName"
    // keeps the type system happy if the form somehow saved without one.
    const field = (form.personaField || "firstName") as PersonaFieldKey;
    return { kind: "persona_field", config: { field } };
  }
  // DATE
  return {
    kind: "date",
    config: {
      mode: form.dateMode,
      relativeDays:
        form.dateMode === "relative" ? parseInt(form.dateRelativeDays, 10) : undefined,
      start:
        form.dateMode === "range" ? new Date(form.dateStart).getTime() : undefined,
      end:
        form.dateMode === "range" ? new Date(form.dateEnd).getTime() : undefined,
    },
  };
}

function validateForm(
  form: VariableForm,
  variables: CustomVariable[],
  editingId?: string | null,
): string[] {
  const errs: string[] = [];
  if (!form.label.trim()) errs.push("Label is required.");
  if (form.label.length > 64) errs.push("Label must be 64 characters or fewer.");
  if (!form.apiIdentifier) errs.push("API Identifier is required.");
  else if (!/^[a-z0-9_]{1,35}$/.test(form.apiIdentifier))
    errs.push("API Identifier: 1–35 lowercase letters, digits, or underscores.");
  else if (variables.some((v) => v.apiIdentifier === form.apiIdentifier && v.id !== editingId))
    errs.push("API Identifier is already in use by another variable.");

  if (form.type === "STRING" && form.stringOptions.length === 0)
    errs.push("Add at least one option for this STRING variable.");
  if (form.type === "PERSONA" && !form.personaField)
    errs.push("Select a persona field.");
  if (form.type === "NUMBER" && form.numberMode === "range") {
    const mn = parseFloat(form.numberMin);
    const mx = parseFloat(form.numberMax);
    if (isNaN(mn) || isNaN(mx)) errs.push("Enter valid min and max values.");
    else if (mn >= mx) errs.push("Min must be less than max.");
  }
  if (form.type === "NUMBER" && form.numberMode === "static") {
    if (isNaN(parseFloat(form.numberStatic))) errs.push("Enter a valid static value.");
  }
  if (form.type === "DATE" && form.dateMode === "relative") {
    const days = parseInt(form.dateRelativeDays, 10);
    if (isNaN(days) || days < 1 || days > 365) errs.push("Relative days must be 1–365.");
  }
  if (form.type === "DATE" && form.dateMode === "range") {
    if (!form.dateStart || !form.dateEnd) errs.push("Enter both start and end dates.");
    else if (new Date(form.dateStart) >= new Date(form.dateEnd))
      errs.push("Start date must be before end date.");
  }
  return errs;
}

function valueSummary(v: CustomVariable): string {
  if (v.values.kind === "string") {
    const n = v.values.config.options.length;
    if (n === 0) return "No options";
    if (n <= 3)
      return v.values.config.options.map((o) => o.text).join(", ");
    return `${v.values.config.options
      .slice(0, 2)
      .map((o) => o.text)
      .join(", ")}, +${n - 2} more`;
  }
  if (v.values.kind === "number") {
    const c = v.values.config;
    if (c.mode === "static") return `Static: ${c.staticValue ?? 0}`;
    return `Range: ${c.min ?? "?"} – ${c.max ?? "?"}`;
  }
  if (v.values.kind === "date") {
    const c = v.values.config;
    if (c.mode === "relative") return `Last ${c.relativeDays ?? 30} days`;
    if (c.start && c.end)
      return `${new Date(c.start).toLocaleDateString()} – ${new Date(c.end).toLocaleDateString()}`;
  }
  // persona_field is rendered with monospace markup via PersonaFieldPreview
  // in the row, so the summary string is only a screen-reader fallback.
  if (v.values.kind === "persona_field") {
    return `persona.${v.values.config.field}`;
  }
  return "";
}

/** Inline preview shown for persona_field variables — uses muted monospace
 *  to match an arrow-from-persona-field style and includes a user icon. */
function PersonaFieldPreview({ field }: { field: PersonaFieldKey }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <User className="h-3 w-3" />
      <span>→</span>
      <span className="font-mono">persona.{field}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CustomVariablesSection() {
  const variables = useGenerationStore((s) => s.draft.customVariables);
  const setDraft = useGenerationStore((s) => s.setDraft);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<VariableForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<string[]>([]);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (formOpen) {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [formOpen]);

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setErrors([]);
    setFormOpen(true);
  }

  function openPreset(preset: VariablePreset) {
    if (variables.some((v) => v.apiIdentifier === preset.apiIdentifier)) {
      toast.warning(`"${preset.label}" already added`, {
        description: `Edit the existing "${preset.apiIdentifier}" variable below.`,
      });
      return;
    }
    setForm(presetToForm(preset));
    setEditingId(null);
    setErrors([]);
    setFormOpen(true);
  }

  function openEdit(variable: CustomVariable) {
    setForm(variableToForm(variable));
    setEditingId(variable.id);
    setErrors([]);
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setErrors([]);
  }

  function handleSave() {
    const errs = validateForm(form, variables, editingId);
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    const variable: CustomVariable = {
      id: editingId ?? crypto.randomUUID(),
      label: form.label.trim(),
      apiIdentifier: form.apiIdentifier,
      type: form.type,
      values: formToValues(form),
    };
    setDraft((draft) => {
      if (editingId) {
        draft.customVariables = draft.customVariables.map((v) =>
          v.id === editingId ? variable : v,
        );
      } else {
        draft.customVariables = [...draft.customVariables, variable];
      }
    });
    toast.success(editingId ? "Variable updated" : "Variable added");
    closeForm();
  }

  function handleDelete(id: string) {
    setDraft((draft) => {
      draft.customVariables = draft.customVariables.filter((v) => v.id !== id);
    });
    if (editingId === id) closeForm();
  }

  function setF<K extends keyof VariableForm>(key: K, value: VariableForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors.length > 0) setErrors([]);
  }

  function handleLabelChange(label: string) {
    setForm((prev) => ({
      ...prev,
      label,
      apiIdentifier: prev.apiIdentifierTouched
        ? prev.apiIdentifier
        : deriveIdentifier(label),
    }));
    if (errors.length > 0) setErrors([]);
  }

  function handleTypeChange(type: VariableType) {
    setForm((prev) => ({ ...prev, type }));
    if (errors.length > 0) setErrors([]);
  }

  // STRING option helpers
  function addStringOption() {
    const text = form.stringOptionDraft.trim();
    if (!text) return;
    if (form.stringOptions.some((o) => o.text.toLowerCase() === text.toLowerCase())) {
      toast.warning("Duplicate option", { description: `"${text}" is already in the list.` });
      return;
    }
    const newOption: StringOption = { id: crypto.randomUUID(), text, weight: 0 };
    setForm((prev) => ({
      ...prev,
      stringOptions: [...prev.stringOptions, newOption],
      stringOptionDraft: "",
    }));
  }

  function removeStringOption(id: string) {
    const items: WeightedItem[] = form.stringOptions.map((o) => ({
      key: o.id,
      value: o.weight,
    }));
    const next = removeKeyAndRedistribute(items, id, new Set(), undefined, 100);
    const byKey = new Map(next.map((i) => [i.key, i.value]));
    setForm((prev) => ({
      ...prev,
      stringOptions: prev.stringOptions
        .filter((o) => o.id !== id)
        .map((o) => ({ ...o, weight: byKey.get(o.id) ?? o.weight })),
    }));
  }

  function changeStringOptionWeight(id: string, raw: string) {
    const val = parseInt(raw, 10);
    if (!Number.isFinite(val)) return;
    const clamped = Math.max(0, Math.min(100, val));
    const items: WeightedItem[] = form.stringOptions.map((o) => ({
      key: o.id,
      value: o.weight,
    }));
    const next = rebalanceToTotal(items, id, clamped, new Set(), 100);
    const byKey = new Map(next.map((i) => [i.key, i.value]));
    setForm((prev) => ({
      ...prev,
      stringOptions: prev.stringOptions.map((o) => ({
        ...o,
        weight: byKey.get(o.id) ?? o.weight,
      })),
    }));
  }

  function autoBalanceStringOptions() {
    const items: WeightedItem[] = form.stringOptions.map((o) => ({
      key: o.id,
      value: o.weight,
    }));
    const next = distributeEvenly(items, new Set(), 100);
    const byKey = new Map(next.map((i) => [i.key, i.value]));
    setForm((prev) => ({
      ...prev,
      stringOptions: prev.stringOptions.map((o) => ({
        ...o,
        weight: byKey.get(o.id) ?? o.weight,
      })),
    }));
  }

  const optionSum = form.stringOptions.reduce((s, o) => s + o.weight, 0);
  const optionSumOk = optionSum === 100 || form.stringOptions.length === 0;
  const alreadyAddedIds = new Set(variables.map((v) => v.apiIdentifier));

  return (
    <section id="variables" className="scroll-mt-24">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Boxes className="h-4 w-4" />
            Custom Variables
          </CardTitle>
          <CardDescription>
            Define workspace variables that Plumage injects into each generated
            response. Use STRING options for weighted lists, NUMBER for ranges or
            fixed values, and DATE for relative or absolute windows.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Preset chips */}
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Suggestions</p>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => {
                const added = alreadyAddedIds.has(p.apiIdentifier);
                return (
                  <Tooltip key={p.apiIdentifier}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => openPreset(p)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                          added
                            ? "cursor-default border-transparent bg-muted text-muted-foreground"
                            : "hover:border-primary hover:bg-primary/10 hover:text-primary",
                        )}
                        disabled={added}
                      >
                        {p.label}
                        {added && (
                          <span className="font-normal text-muted-foreground">
                            · added
                          </span>
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {added
                        ? `${p.apiIdentifier} is already in your list`
                        : `Add ${p.description} (${p.apiIdentifier})`}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          <Separator />

          {/* Sync reminder — only when at least one variable is configured.
              Copy updated 8d: Plumage now auto-creates missing AI variables
              before pushing, so the old "you must manually create them in
              SS" warning was misleading. */}
          {variables.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Plumage will check these variables before pushing responses.
                Existing SurveySparrow variables are reused; any missing
                AI-suggested variables are created automatically via{" "}
                <code className="rounded bg-warning/20 px-1 font-mono text-[10px]">
                  /v3/variables/batch
                </code>{" "}
                first. Only variable <em>definitions</em> are created in SS —
                the suggested option values stay inside Plumage and drive
                realistic response payloads.
              </span>
            </div>
          )}

          {/* Variable list */}
          {variables.length === 0 && !formOpen ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No custom variables yet. Pick a suggestion above or add one below.
            </p>
          ) : (
            <ul className="space-y-2">
              {variables.map((v) => (
                <li
                  key={v.id}
                  className={cn(
                    "flex items-start justify-between gap-3 rounded-md border bg-background p-3",
                    editingId === v.id && "border-primary/50 bg-primary/5",
                  )}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{v.label}</span>
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px] uppercase tracking-wider"
                      >
                        {v.apiIdentifier}
                      </Badge>
                      <TypeBadge type={v.type} />
                    </div>
                    {v.values.kind === "persona_field" ? (
                      <PersonaFieldPreview field={v.values.config.field} />
                    ) : (
                      <p className="text-xs text-muted-foreground">{valueSummary(v)}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          onClick={() => openEdit(v)}
                          aria-label={`Edit ${v.label}`}
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Edit</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(v.id)}
                          aria-label={`Delete ${v.label}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete</TooltipContent>
                    </Tooltip>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Add button */}
          {!formOpen && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openAdd}
            >
              <Plus className="h-3.5 w-3.5" />
              Add variable
            </Button>
          )}

          {/* Inline add/edit form */}
          {formOpen && (
            <div
              ref={formRef}
              className="rounded-lg border border-primary/30 bg-card p-4 shadow-sm"
            >
              <p className="mb-3 text-sm font-medium">
                {editingId ? "Edit variable" : "New variable"}
              </p>

              {/* Label + API Identifier */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="var-label">
                    Label <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="var-label"
                    value={form.label}
                    onChange={(e) => handleLabelChange(e.target.value)}
                    maxLength={64}
                    placeholder="e.g. Products"
                    className="h-8 text-sm"
                    autoFocus
                  />
                  <p className="text-right text-[10px] text-muted-foreground">
                    {form.label.length}/64
                  </p>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="var-id">
                    API Identifier <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="var-id"
                    value={form.apiIdentifier}
                    onChange={(e) => {
                      const val = e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_]/g, "")
                        .slice(0, 35);
                      setForm((prev) => ({
                        ...prev,
                        apiIdentifier: val,
                        apiIdentifierTouched: true,
                      }));
                      if (errors.length > 0) setErrors([]);
                    }}
                    placeholder="e.g. sys_products"
                    className="h-8 font-mono text-sm"
                  />
                  <p className="text-right text-[10px] text-muted-foreground">
                    {form.apiIdentifier.length}/35
                  </p>
                </div>
              </div>

              {/* Type selector */}
              <div className="mt-3 space-y-1">
                <p className="text-xs font-medium">Type</p>
                <div className="flex flex-wrap gap-1.5">
                  {TYPE_OPTIONS.map((opt) => (
                    <Tooltip key={opt.id}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => handleTypeChange(opt.id)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                            form.type === opt.id
                              ? "border-primary bg-primary text-primary-foreground"
                              : "hover:border-primary/50 hover:bg-primary/10",
                          )}
                        >
                          {opt.id === "PERSONA" && <User className="h-3 w-3" />}
                          {opt.id}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        {opt.tooltip}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>

              {/* Type-specific controls */}
              <div className="mt-3">
                {form.type === "STRING" && (
                  <StringOptionsEditor
                    options={form.stringOptions}
                    draft={form.stringOptionDraft}
                    optionSum={optionSum}
                    optionSumOk={optionSumOk}
                    onDraftChange={(v) => setF("stringOptionDraft", v)}
                    onAdd={addStringOption}
                    onRemove={removeStringOption}
                    onWeightChange={changeStringOptionWeight}
                    onAutoBalance={autoBalanceStringOptions}
                  />
                )}
                {form.type === "NUMBER" && (
                  <NumberConfig
                    mode={form.numberMode}
                    min={form.numberMin}
                    max={form.numberMax}
                    staticVal={form.numberStatic}
                    onModeChange={(v) => setF("numberMode", v)}
                    onMinChange={(v) => setF("numberMin", v)}
                    onMaxChange={(v) => setF("numberMax", v)}
                    onStaticChange={(v) => setF("numberStatic", v)}
                  />
                )}
                {form.type === "DATE" && (
                  <DateConfig
                    mode={form.dateMode}
                    relativeDays={form.dateRelativeDays}
                    start={form.dateStart}
                    end={form.dateEnd}
                    onModeChange={(v) => setF("dateMode", v)}
                    onRelativeDaysChange={(v) => setF("dateRelativeDays", v)}
                    onStartChange={(v) => setF("dateStart", v)}
                    onEndChange={(v) => setF("dateEnd", v)}
                  />
                )}
                {form.type === "PERSONA" && (
                  <PersonaFieldPicker
                    value={form.personaField}
                    onChange={(field) => setF("personaField", field)}
                  />
                )}
              </div>

              {/* Validation errors */}
              {errors.length > 0 && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <ul className="list-inside list-disc space-y-0.5">
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Form actions */}
              <div className="mt-4 flex gap-2">
                <Button type="button" size="sm" onClick={handleSave}>
                  {editingId ? "Save changes" : "Add variable"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={closeForm}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TypeBadge({ type }: { type: VariableType }) {
  const colors: Record<VariableType, string> = {
    STRING: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    NUMBER: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    DATE: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    PERSONA: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        colors[type],
      )}
    >
      {type}
    </span>
  );
}

interface StringOptionsEditorProps {
  options: StringOption[];
  draft: string;
  optionSum: number;
  optionSumOk: boolean;
  onDraftChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onWeightChange: (id: string, raw: string) => void;
  onAutoBalance: () => void;
}

function StringOptionsEditor({
  options,
  draft,
  optionSum,
  optionSumOk,
  onDraftChange,
  onAdd,
  onRemove,
  onWeightChange,
  onAutoBalance,
}: StringOptionsEditorProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Options</p>

      {/* Add option input */}
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder="Option text…"
          className="h-8 text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          disabled={!draft.trim()}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {/* Option rows */}
      {options.length > 0 && (
        <div className="space-y-1.5 rounded-md border bg-muted/20 p-2.5">
          {options.map((o) => (
            <div key={o.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{o.text}</span>
              <div className="flex items-center gap-1 shrink-0">
                <Input
                  type="number"
                  inputMode="numeric"
                  value={o.weight}
                  onChange={(e) => onWeightChange(o.id, e.target.value)}
                  min={0}
                  max={100}
                  className="h-7 w-14 px-2 text-right tabular-nums text-xs"
                />
                <span className="w-3 text-xs text-muted-foreground">%</span>
                <button
                  type="button"
                  onClick={() => onRemove(o.id)}
                  className="ml-0.5 rounded p-0.5 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${o.text}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}

          {/* Sum + auto-balance */}
          <div className="flex items-center justify-between pt-1">
            <span
              className={cn(
                "text-[11px] tabular-nums font-medium",
                optionSumOk ? "text-muted-foreground" : "text-warning",
              )}
            >
              Total: {optionSum}%{!optionSumOk && " ⚠ should be 100"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={onAutoBalance}
              disabled={options.length === 0}
            >
              <Wand2 className="h-3 w-3" />
              Auto-balance
            </Button>
          </div>
        </div>
      )}

      {options.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No options yet. Add at least one.
        </p>
      )}
    </div>
  );
}

interface NumberConfigProps {
  mode: "range" | "static";
  min: string;
  max: string;
  staticVal: string;
  onModeChange: (v: "range" | "static") => void;
  onMinChange: (v: string) => void;
  onMaxChange: (v: string) => void;
  onStaticChange: (v: string) => void;
}

function NumberConfig({
  mode,
  min,
  max,
  staticVal,
  onModeChange,
  onMinChange,
  onMaxChange,
  onStaticChange,
}: NumberConfigProps) {
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {(["range", "static"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            className={cn(
              "rounded-md border px-3 py-1 text-xs font-medium capitalize transition-colors",
              mode === m
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:border-primary/50 hover:bg-primary/10",
            )}
          >
            {m}
          </button>
        ))}
      </div>
      {mode === "range" && (
        <div className="flex items-center gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Min</label>
            <Input
              type="number"
              value={min}
              onChange={(e) => onMinChange(e.target.value)}
              className="h-8 w-24 text-sm"
            />
          </div>
          <span className="mt-5 text-muted-foreground">–</span>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Max</label>
            <Input
              type="number"
              value={max}
              onChange={(e) => onMaxChange(e.target.value)}
              className="h-8 w-24 text-sm"
            />
          </div>
        </div>
      )}
      {mode === "static" && (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Value</label>
          <Input
            type="number"
            value={staticVal}
            onChange={(e) => onStaticChange(e.target.value)}
            className="h-8 w-32 text-sm"
          />
        </div>
      )}
    </div>
  );
}

interface DateConfigProps {
  mode: "relative" | "range";
  relativeDays: string;
  start: string;
  end: string;
  onModeChange: (v: "relative" | "range") => void;
  onRelativeDaysChange: (v: string) => void;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
}

function DateConfig({
  mode,
  relativeDays,
  start,
  end,
  onModeChange,
  onRelativeDaysChange,
  onStartChange,
  onEndChange,
}: DateConfigProps) {
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {(["relative", "range"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            className={cn(
              "rounded-md border px-3 py-1 text-xs font-medium capitalize transition-colors",
              mode === m
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:border-primary/50 hover:bg-primary/10",
            )}
          >
            {m}
          </button>
        ))}
      </div>
      {mode === "relative" && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Last</span>
          <Input
            type="number"
            value={relativeDays}
            onChange={(e) => onRelativeDaysChange(e.target.value)}
            min={1}
            max={365}
            className="h-8 w-20 text-sm"
          />
          <span className="text-xs text-muted-foreground">days</span>
        </div>
      )}
      {mode === "range" && (
        <div className="flex items-center gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Start</label>
            <Input
              type="date"
              value={start}
              onChange={(e) => onStartChange(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <span className="mt-5 text-muted-foreground">–</span>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">End</label>
            <Input
              type="date"
              value={end}
              onChange={(e) => onEndChange(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Persona-field picker
// ---------------------------------------------------------------------------

interface PersonaFieldPickerProps {
  value: PersonaFieldKey | "";
  onChange: (field: PersonaFieldKey) => void;
}

function PersonaFieldPicker({ value, onChange }: PersonaFieldPickerProps) {
  const selected = value
    ? PERSONA_FIELD_OPTIONS.find((o) => o.key === value)
    : undefined;
  return (
    <div className="space-y-3">
      <p className="text-xs font-medium">Select a persona field</p>
      {/* Grid of selectable chips — each shows label + an example value in
          muted text so SEs immediately see what shape the variable takes. */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {PERSONA_FIELD_OPTIONS.map((opt) => {
          const active = value === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => onChange(opt.key)}
              aria-pressed={active}
              className={cn(
                "flex flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors",
                active
                  ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/20"
                  : "border-border hover:border-primary/40 hover:bg-primary/5",
              )}
            >
              <span className="flex items-center gap-1 font-medium">
                <User className="h-3 w-3 text-muted-foreground" />
                {opt.label}
              </span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {opt.example}
              </span>
            </button>
          );
        })}
      </div>
      {selected ? (
        <p className="rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Each response will use the persona&apos;s{" "}
          <span className="font-medium text-foreground">{selected.label}</span>{" "}
          as this variable&apos;s value.
        </p>
      ) : (
        <p className="text-[11px] italic text-muted-foreground">
          Pick a field above. The same persona drives both the response content
          and this variable&apos;s value, so they stay consistent in the demo.
        </p>
      )}
    </div>
  );
}
