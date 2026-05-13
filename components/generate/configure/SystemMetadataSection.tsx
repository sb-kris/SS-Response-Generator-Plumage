"use client";

import { useMemo, useState } from "react";
import { useGenerationStore } from "@/store/generation-store";
import {
  mergeSystemMetadata,
  type MetadataWeightedOption,
  type SystemMetadataConfig,
} from "@/lib/profiles/types";
import {
  rebalanceToTotal,
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
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertCircle,
  Globe2,
  Info,
  Tag,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function optionItems(options: MetadataWeightedOption[]): WeightedItem[] {
  return options.map((o) => ({ key: o.value, value: o.weight }));
}

function applyItems(
  original: MetadataWeightedOption[],
  next: WeightedItem[],
): MetadataWeightedOption[] {
  const byKey = new Map(next.map((i) => [i.key, i.value]));
  return original.map((o) => ({ ...o, weight: byKey.get(o.value) ?? o.weight }));
}

function optionSum(options: MetadataWeightedOption[]): number {
  return options.reduce((s, o) => s + o.weight, 0);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SystemMetadataSection() {
  const rawMetadata = useGenerationStore((s) => s.draft.systemMetadata);
  const setDraft = useGenerationStore((s) => s.setDraft);

  // Normalize on read so the component never crashes on stale sessionStorage or
  // old profiles that predate the 3f schema (which have a different shape).
  const metadata = useMemo(() => mergeSystemMetadata(rawMetadata), [rawMetadata]);

  function update(patch: Partial<SystemMetadataConfig>) {
    setDraft((draft) => {
      // Base the write on the merged shape so a single toggle also fixes any
      // missing keys from old data in one pass.
      draft.systemMetadata = { ...mergeSystemMetadata(draft.systemMetadata), ...patch };
    });
  }

  function toggleField(field: keyof SystemMetadataConfig) {
    const current = metadata[field] as { enabled: boolean };
    update({ [field]: { ...current, enabled: !current.enabled } });
  }

  // ---------------------------------------------------------------------------
  // Weighted-options updaters (device_type / browser / os)
  // ---------------------------------------------------------------------------

  function changeOptionWeight(
    field: "device_type" | "browser" | "os",
    value: string,
    raw: string,
  ) {
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(0, Math.min(100, parsed));
    const current = metadata[field].options;
    const next = applyItems(
      current,
      rebalanceToTotal(optionItems(current), value, clamped, new Set(), 100),
    );
    update({ [field]: { ...metadata[field], options: next } });
  }

  function autoBalanceField(field: "device_type" | "browser" | "os") {
    const current = metadata[field].options;
    const next = applyItems(
      current,
      distributeEvenly(optionItems(current), new Set(), 100),
    );
    update({ [field]: { ...metadata[field], options: next } });
  }

  // ---------------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------------

  const [tagDraft, setTagDraft] = useState("");

  function addTag() {
    const tag = tagDraft.trim();
    if (!tag) return;
    if (metadata.tags.values.includes(tag)) return;
    update({ tags: { ...metadata.tags, values: [...metadata.tags.values, tag] } });
    setTagDraft("");
  }

  function removeTag(tag: string) {
    update({
      tags: { ...metadata.tags, values: metadata.tags.values.filter((t) => t !== tag) },
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <section id="metadata" className="scroll-mt-24">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe2 className="h-4 w-4" />
            System Metadata
          </CardTitle>
          <CardDescription>
            Control what SurveySparrow{" "}
            <code className="rounded bg-muted px-1 font-mono text-[11px]">
              meta_data
            </code>{" "}
            fields Plumage injects into each generated response. Disabled fields
            are omitted from the API call.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          {/* device_type */}
          <FieldRow
            enabled={metadata.device_type.enabled}
            onToggle={() => toggleField("device_type")}
            label="Device Type"
            fieldKey="device_type"
            description="Simulated device of the respondent."
          >
            <WeightedOptionsField
              options={metadata.device_type.options}
              onWeightChange={(val, raw) => changeOptionWeight("device_type", val, raw)}
              onAutoBalance={() => autoBalanceField("device_type")}
            />
          </FieldRow>

          {/* browser */}
          <FieldRow
            enabled={metadata.browser.enabled}
            onToggle={() => toggleField("browser")}
            label="Browser"
            fieldKey="browser"
            description="Browser used to submit the response."
          >
            <WeightedOptionsField
              options={metadata.browser.options}
              onWeightChange={(val, raw) => changeOptionWeight("browser", val, raw)}
              onAutoBalance={() => autoBalanceField("browser")}
            />
          </FieldRow>

          {/* os */}
          <FieldRow
            enabled={metadata.os.enabled}
            onToggle={() => toggleField("os")}
            label="Operating System"
            fieldKey="os"
            description="OS of the respondent's device."
          >
            <WeightedOptionsField
              options={metadata.os.options}
              onWeightChange={(val, raw) => changeOptionWeight("os", val, raw)}
              onAutoBalance={() => autoBalanceField("os")}
            />
          </FieldRow>

          {/* browser_language */}
          <FieldRow
            enabled={metadata.browser_language.enabled}
            onToggle={() => toggleField("browser_language")}
            label="Browser Language"
            fieldKey="browser_language"
            description="Locale of the respondent's browser."
            readOnly
          >
            <ReadOnlyMirrorNote
              note="Automatically mirrors your Language distribution. Personas receive the
                locale for their assigned language."
            />
          </FieldRow>

          {/* language */}
          <FieldRow
            enabled={metadata.language.enabled}
            onToggle={() => toggleField("language")}
            label="Survey Language"
            fieldKey="language"
            description="The language in which the survey was presented."
            readOnly
          >
            <ReadOnlyMirrorNote
              note="Automatically mirrors your Language distribution."
            />
          </FieldRow>

          {/* time_zone */}
          <FieldRow
            enabled={metadata.time_zone.enabled}
            onToggle={() => toggleField("time_zone")}
            label="Timezone"
            fieldKey="time_zone"
            description="IANA timezone of the respondent."
          >
            <TimezoneField
              forceTimezone={metadata.time_zone.forceTimezone}
              onChange={(v) =>
                update({ time_zone: { ...metadata.time_zone, forceTimezone: v } })
              }
            />
          </FieldRow>

          {/* ip */}
          <FieldRow
            enabled={metadata.ip.enabled}
            onToggle={() => toggleField("ip")}
            label="IP Address"
            fieldKey="ip"
            description="Simulated IP address attached to the response."
          >
            <IpField
              mode={metadata.ip.mode}
              fixedIp={metadata.ip.fixedIp}
              onModeChange={(mode) =>
                update({ ip: { ...metadata.ip, mode } })
              }
              onFixedIpChange={(fixedIp) =>
                update({ ip: { ...metadata.ip, fixedIp } })
              }
            />
          </FieldRow>

          {/* tags */}
          <FieldRow
            enabled={metadata.tags.enabled}
            onToggle={() => toggleField("tags")}
            label="Tags"
            fieldKey="tags"
            description="Labels applied to every generated response in SS."
          >
            <TagsField
              values={metadata.tags.values}
              draft={tagDraft}
              onDraftChange={setTagDraft}
              onAdd={addTag}
              onRemove={removeTag}
            />
          </FieldRow>

          {/* date_time */}
          <FieldRow
            enabled={metadata.date_time.enabled}
            onToggle={() => toggleField("date_time")}
            label="Submission Timestamp"
            fieldKey="date_time"
            description="The datetime recorded for each response."
            readOnly
          >
            <ReadOnlyMirrorNote
              note="Driven by the Timing section. Enable now to include the field; timing
                controls land next."
            />
          </FieldRow>
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Field row wrapper
// ---------------------------------------------------------------------------

interface FieldRowProps {
  enabled: boolean;
  onToggle: () => void;
  label: string;
  fieldKey: string;
  description: string;
  readOnly?: boolean;
  children: React.ReactNode;
}

function FieldRow({
  enabled,
  onToggle,
  label,
  fieldKey,
  description,
  readOnly,
  children,
}: FieldRowProps) {
  return (
    <div
      className={cn(
        "rounded-md border transition-colors",
        enabled ? "bg-background" : "bg-muted/20",
      )}
    >
      <div className="flex items-start gap-3 p-3">
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          aria-label={`${enabled ? "Disable" : "Enable"} ${label}`}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{label}</span>
            <code className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
              {fieldKey}
            </code>
            {readOnly && (
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[9px] uppercase tracking-wider text-muted-foreground"
              >
                auto
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>

          {enabled && <div className="mt-3">{children}</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weighted options field (device_type / browser / os)
// ---------------------------------------------------------------------------

interface WeightedOptionsFieldProps {
  options: MetadataWeightedOption[];
  onWeightChange: (value: string, raw: string) => void;
  onAutoBalance: () => void;
}

function WeightedOptionsField({
  options,
  onWeightChange,
  onAutoBalance,
}: WeightedOptionsFieldProps) {
  const sum = optionSum(options);
  const sumOk = sum === 100;

  return (
    <div className="space-y-2">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {options.map((o) => (
          <div key={o.value} className="flex items-center justify-between gap-2">
            <span className="text-xs">{o.value}</span>
            <div className="flex items-center gap-1">
              <Input
                type="number"
                inputMode="numeric"
                value={o.weight}
                onChange={(e) => onWeightChange(o.value, e.target.value)}
                min={0}
                max={100}
                className="h-7 w-16 px-2 text-right tabular-nums text-xs"
                aria-label={`${o.value} weight`}
              />
              <span className="w-3 text-xs text-muted-foreground">%</span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between">
        {!sumOk && (
          <span className="flex items-center gap-1 text-[11px] text-warning">
            <AlertCircle className="h-3 w-3" />
            Total: {sum}% — should be 100
          </span>
        )}
        {sumOk && <span />}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={onAutoBalance}
            >
              <Wand2 className="h-3 w-3" />
              Auto-balance
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">Split 100% evenly across options.</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only mirror note
// ---------------------------------------------------------------------------

function ReadOnlyMirrorNote({ note }: { note: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{note}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timezone field
// ---------------------------------------------------------------------------

interface TimezoneFieldProps {
  forceTimezone?: string;
  onChange: (v: string | undefined) => void;
}

function TimezoneField({ forceTimezone, onChange }: TimezoneFieldProps) {
  const isForced = forceTimezone !== undefined && forceTimezone !== "";

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1.5">
        <RadioOption
          selected={!isForced}
          label="Follow persona geography"
          description="Each persona gets the timezone of their assigned country."
          onSelect={() => onChange(undefined)}
        />
        <RadioOption
          selected={isForced}
          label="Force timezone"
          description="Use a single IANA timezone for all responses."
          onSelect={() => onChange("")}
        />
      </div>
      {isForced && (
        <Input
          value={forceTimezone}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. America/New_York"
          className="h-8 text-sm font-mono"
          autoFocus
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IP field
// ---------------------------------------------------------------------------

interface IpFieldProps {
  mode: "none" | "coherent" | "fixed";
  fixedIp?: string;
  onModeChange: (mode: "none" | "coherent" | "fixed") => void;
  onFixedIpChange: (ip: string) => void;
}

function IpField({ mode, fixedIp, onModeChange, onFixedIpChange }: IpFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1.5">
        <RadioOption
          selected={mode === "none"}
          label="None"
          description="Omit the IP field entirely."
          onSelect={() => onModeChange("none")}
        />
        <RadioOption
          selected={mode === "coherent"}
          label="Coherent"
          description="Generate a geo-consistent IP that matches each persona's country."
          onSelect={() => onModeChange("coherent")}
        />
        <RadioOption
          selected={mode === "fixed"}
          label="Fixed"
          description="Use the same IP address for every response."
          onSelect={() => onModeChange("fixed")}
        />
      </div>
      {mode === "fixed" && (
        <Input
          value={fixedIp ?? ""}
          onChange={(e) => onFixedIpChange(e.target.value)}
          placeholder="e.g. 203.0.113.42"
          className="h-8 font-mono text-sm"
          autoFocus
        />
      )}
      {(mode === "coherent" || mode === "fixed") && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Make sure IP address collection is enabled in your SurveySparrow
            survey settings. If disabled in SS, the IP field will be ignored.
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tags field
// ---------------------------------------------------------------------------

interface TagsFieldProps {
  values: string[];
  draft: string;
  onDraftChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (tag: string) => void;
}

function TagsField({ values, draft, onDraftChange, onAdd, onRemove }: TagsFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-0.5 text-xs font-medium"
          >
            <Tag className="h-2.5 w-2.5 text-muted-foreground" />
            {tag}
            <button
              type="button"
              onClick={() => onRemove(tag)}
              className="ml-0.5 text-muted-foreground hover:text-destructive"
              aria-label={`Remove tag ${tag}`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {values.length === 0 && (
          <span className="text-xs text-muted-foreground">No tags yet.</span>
        )}
      </div>
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
          placeholder="Add a tag…"
          className="h-8 text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          disabled={!draft.trim()}
        >
          Add
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Tags appear on every generated response in SurveySparrow. The{" "}
        <code className="rounded bg-muted px-1 font-mono">plumage-YYYY-MM</code> tag
        makes demo data easy to find and clean up later.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared radio-option button
// ---------------------------------------------------------------------------

interface RadioOptionProps {
  selected: boolean;
  label: string;
  description: string;
  onSelect: () => void;
}

function RadioOption({ selected, label, description, onSelect }: RadioOptionProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2.5 rounded-md border p-2.5 text-left transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : "hover:border-muted-foreground/30 hover:bg-muted/30",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-2",
          selected ? "border-primary" : "border-muted-foreground/50",
        )}
      >
        {selected && (
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
        )}
      </span>
      <span>
        <span className="text-xs font-medium">{label}</span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}
