"use client";

import { useMemo, useState } from "react";
import { useGenerationStore } from "@/store/generation-store";
import { useSurveyStore } from "@/store/survey-store";
import { getSuggestionsForSurveyType } from "@/lib/themes/suggestions";
import type { ThemeConfig } from "@/lib/profiles/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { Plus, Trash2, Lightbulb, Tags, X, Pencil } from "lucide-react";
import { toast } from "sonner";

const MAX_THEMES = 8;
const DEFAULT_WEIGHT = 50;
const VISIBLE_SUGGESTIONS = 6;

function makeThemeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `theme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ThemesSection() {
  const themes = useGenerationStore((s) => s.draft.themes);
  const setDraft = useGenerationStore((s) => s.setDraft);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const surveys = useSurveyStore((s) => s.surveys.data);
  const selectedSurveyType = useMemo(
    () => surveys?.find((s) => s.id === selectedSurveyId)?.survey_type,
    [surveys, selectedSurveyId],
  );

  const suggestions = useMemo(
    () => getSuggestionsForSurveyType(selectedSurveyType),
    [selectedSurveyType],
  );

  const [input, setInput] = useState("");
  const [showAllSuggestions, setShowAllSuggestions] = useState(false);

  const atCap = themes.length >= MAX_THEMES;
  const existingLabels = useMemo(
    () => new Set(themes.map((t) => t.label.toLowerCase())),
    [themes],
  );

  function addThemeFromString(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (atCap) {
      toast.error("Max 8 themes", {
        description: "Remove one to add another.",
      });
      return;
    }
    if (existingLabels.has(trimmed.toLowerCase())) {
      toast.message("Already added", { description: trimmed });
      return;
    }
    const next: ThemeConfig = {
      id: makeThemeId(),
      label: trimmed,
      weight: DEFAULT_WEIGHT,
    };
    setDraft((draft) => {
      draft.themes = [...draft.themes, next];
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    addThemeFromString(input);
    setInput("");
  }

  function updateTheme(id: string, partial: Partial<ThemeConfig>) {
    setDraft((draft) => {
      draft.themes = draft.themes.map((t) =>
        t.id === id ? { ...t, ...partial } : t,
      );
    });
  }

  function removeTheme(id: string) {
    setDraft((draft) => {
      draft.themes = draft.themes.filter((t) => t.id !== id);
    });
  }

  const visibleSuggestions = showAllSuggestions
    ? suggestions.themes
    : suggestions.themes.slice(0, VISIBLE_SUGGESTIONS);

  return (
    <section id="themes" className="scroll-mt-24">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Tags className="h-4 w-4" />
                Themes
                <Badge variant="secondary" className="font-normal">
                  {themes.length} / {MAX_THEMES}
                </Badge>
              </CardTitle>
              <CardDescription>
                What your synthetic respondents talk about. Weights are{" "}
                <em>relative</em> — they shape how often each theme appears,
                not an exact percentage.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <form onSubmit={handleSubmit} className="flex items-stretch gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                atCap
                  ? "Max 8 themes — remove one to add another"
                  : "Type a theme and press Enter (e.g. installation experience)"
              }
              disabled={atCap}
              maxLength={60}
              aria-label="New theme"
            />
            <Button type="submit" disabled={atCap || input.trim().length === 0}>
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </form>

          {/* Suggestion chips */}
          {!atCap && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lightbulb className="h-3.5 w-3.5" />
                <span>
                  Suggestions for{" "}
                  <span className="font-medium text-foreground">
                    {suggestions.label}
                  </span>{" "}
                  surveys
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {visibleSuggestions
                  .filter((s) => !existingLabels.has(s.toLowerCase()))
                  .map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => addThemeFromString(s)}
                      disabled={atCap}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs font-medium transition-colors",
                        "hover:border-primary/40 hover:bg-primary/5 hover:text-foreground",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                      )}
                    >
                      <Plus className="h-3 w-3" />
                      {s}
                    </button>
                  ))}
                {!showAllSuggestions && suggestions.themes.length > VISIBLE_SUGGESTIONS && (
                  <button
                    type="button"
                    onClick={() => setShowAllSuggestions(true)}
                    className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Show {suggestions.themes.length - VISIBLE_SUGGESTIONS} more
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Theme list */}
          {themes.length === 0 ? (
            <EmptyThemesState />
          ) : (
            <ul className="space-y-2">
              {themes.map((theme) => (
                <ThemeRow
                  key={theme.id}
                  theme={theme}
                  onUpdate={(partial) => updateTheme(theme.id, partial)}
                  onRemove={() => removeTheme(theme.id)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ThemeRow
// ---------------------------------------------------------------------------

interface ThemeRowProps {
  theme: ThemeConfig;
  onUpdate: (partial: Partial<ThemeConfig>) => void;
  onRemove: () => void;
}

function ThemeRow({ theme, onUpdate, onRemove }: ThemeRowProps) {
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(theme.label);

  function commitLabel() {
    const trimmed = labelDraft.trim();
    if (!trimmed) {
      // Refuse empty labels — revert to previous.
      setLabelDraft(theme.label);
    } else if (trimmed !== theme.label) {
      onUpdate({ label: trimmed });
    }
    setEditing(false);
  }

  function handleWeightChange(values: number[]) {
    const v = values[0];
    if (typeof v === "number") onUpdate({ weight: clampInt(v, 0, 100) });
  }

  function handleNumericInput(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = parseInt(e.target.value, 10);
    if (Number.isFinite(raw)) {
      onUpdate({ weight: clampInt(raw, 0, 100) });
    } else if (e.target.value === "") {
      onUpdate({ weight: 0 });
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border bg-background p-3 sm:flex-nowrap">
      <div className="flex min-w-0 flex-[2] items-center gap-2">
        {editing ? (
          <Input
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitLabel();
              else if (e.key === "Escape") {
                setLabelDraft(theme.label);
                setEditing(false);
              }
            }}
            autoFocus
            maxLength={60}
            className="h-8 text-sm"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="group flex min-w-0 items-center gap-1.5 rounded text-left text-sm font-medium"
            title="Click to rename"
          >
            <span className="truncate">{theme.label}</span>
            <Pencil className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
          </button>
        )}
      </div>

      <div className="flex flex-[3] items-center gap-3 min-w-[200px]">
        <Slider
          value={[theme.weight]}
          onValueChange={handleWeightChange}
          min={0}
          max={100}
          step={1}
          aria-label={`Weight for theme: ${theme.label}`}
        />
        <Input
          type="number"
          inputMode="numeric"
          value={theme.weight}
          onChange={handleNumericInput}
          min={0}
          max={100}
          className="h-8 w-16 px-2 text-right tabular-nums"
        />
      </div>

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label={`Remove theme ${theme.label}`}
        className="text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

function EmptyThemesState() {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 p-6 text-center">
      <X className="mx-auto mb-2 h-5 w-5 text-muted-foreground/60" />
      <div className="text-sm font-medium">No themes yet</div>
      <div className="text-xs text-muted-foreground">
        Themes shape what your synthetic respondents talk about. Add 2–5 to start.
      </div>
    </div>
  );
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
