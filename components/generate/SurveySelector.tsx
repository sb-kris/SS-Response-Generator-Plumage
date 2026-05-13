"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { loggedFetch } from "@/store/api-logs-store";
import type { Survey } from "@/lib/surveysparrow/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { formatRelativeDate } from "@/lib/utils/format-date";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronsUpDown,
  RefreshCw,
  AlertCircle,
  FileQuestion,
} from "lucide-react";
import { toast } from "sonner";

interface FetchSurveysResponse {
  ok: boolean;
  surveys?: Survey[];
  count?: number;
  hiddenCount?: number;
  truncated?: boolean;
  error?: string;
  status?: number;
}

export function SurveySelector() {
  const ssRegion = useSetupStore((s) => s.surveySparrow.region);
  const ssApiKey = useSetupStore((s) => s.surveySparrow.apiKey);

  const surveys = useSurveyStore((s) => s.surveys);
  const setSurveys = useSurveyStore((s) => s.setSurveys);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const selectSurvey = useSurveyStore((s) => s.selectSurvey);

  const [open, setOpen] = useState(false);
  const [hiddenConversational, setHiddenConversational] = useState(0);
  const fetchedOnceRef = useRef(false);

  // Auto-fetch on mount, once.
  useEffect(() => {
    if (fetchedOnceRef.current) return;
    if (surveys.status === "ok" || surveys.status === "loading") return;
    fetchedOnceRef.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setSurveys({ status: "loading", error: null });
    try {
      const res = await loggedFetch(
        "/api/surveysparrow/surveys",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: ssRegion, apiKey: ssApiKey }),
        },
        { kind: "internal", provider: "plumage", contextLabel: "list-surveys" },
      );
      const json = (await res.json()) as FetchSurveysResponse;
      if (!json.ok) {
        setSurveys({
          status: "error",
          error: json.error ?? `Failed to load surveys (HTTP ${res.status})`,
          data: null,
          fetchedAt: null,
        });
        toast.error("Failed to load surveys", {
          description: json.error ?? "Unknown error",
        });
        return;
      }
      setSurveys({
        status: "ok",
        data: json.surveys ?? [],
        truncated: json.truncated,
        fetchedAt: Date.now(),
        error: null,
      });
      setHiddenConversational(json.hiddenCount ?? 0);
      if (json.truncated) {
        toast.warning("Survey list truncated", {
          description: `Showing ${json.count} surveys (pagination cap hit). Archive old ones to see more.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setSurveys({ status: "error", error: msg, data: null, fetchedAt: null });
      toast.error("Network error loading surveys", { description: msg });
    }
  }

  const selectedSurvey = useMemo(
    () => surveys.data?.find((s) => s.id === selectedSurveyId) ?? null,
    [surveys.data, selectedSurveyId],
  );

  if (surveys.status === "loading") return <SurveySelectorSkeleton />;

  if (surveys.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Couldn&apos;t load surveys</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{surveys.error ?? "Unknown error"}</p>
          <Button size="sm" variant="outline" onClick={load} className="bg-background">
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const list = surveys.data ?? [];

  if (list.length === 0) {
    return (
      <Alert>
        <FileQuestion className="h-4 w-4" />
        <AlertTitle>No surveys in this workspace</AlertTitle>
        <AlertDescription>
          Create a survey in SurveySparrow first, then come back here.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Survey</div>
          <div className="text-xs text-muted-foreground">
            {list.length} {list.length === 1 ? "survey" : "surveys"} available
            {hiddenConversational > 0
              ? ` · ${hiddenConversational} conversational hidden`
              : ""}
            {surveys.truncated ? " · list truncated" : ""}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={load}
          aria-label="Refresh survey list"
          title="Refresh survey list"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="h-auto w-full justify-between py-3 text-left"
          >
            {selectedSurvey ? (
              <SelectedSurveyDisplay survey={selectedSurvey} />
            ) : (
              <span className="text-muted-foreground">Pick a survey...</span>
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] p-0"
          align="start"
        >
          <Command
            filter={(value, search) => {
              // `value` is the survey ID we set; search across name + type instead.
              const survey = list.find((x) => String(x.id) === value);
              if (!survey) return 0;
              const haystack = `${survey.name} ${survey.survey_type}`.toLowerCase();
              return haystack.includes(search.toLowerCase()) ? 1 : 0;
            }}
          >
            <CommandInput placeholder="Search surveys by name or type..." />
            <CommandList>
              <CommandEmpty>No surveys match your search.</CommandEmpty>
              <CommandGroup>
                {list.map((survey) => (
                  <CommandItem
                    key={survey.id}
                    value={String(survey.id)}
                    onSelect={(value) => {
                      selectSurvey(parseInt(value, 10));
                      setOpen(false);
                    }}
                    className="items-start"
                  >
                    <Check
                      className={cn(
                        "mt-1 h-4 w-4 shrink-0",
                        selectedSurveyId === survey.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="truncate font-medium">{survey.name}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-[10px]">
                          {survey.survey_type}
                        </Badge>
                        <span>·</span>
                        <span>modified {formatRelativeDate(survey.updated_at)}</span>
                        {survey.archived && (
                          <>
                            <span>·</span>
                            <span className="text-warning">archived</span>
                          </>
                        )}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SelectedSurveyDisplay({ survey }: { survey: Survey }) {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="truncate font-medium">{survey.name}</div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="text-[10px]">
          {survey.survey_type}
        </Badge>
        <span>·</span>
        <span>modified {formatRelativeDate(survey.updated_at)}</span>
        {survey.survey_folder_name ? (
          <>
            <span>·</span>
            <span className="truncate">in {survey.survey_folder_name}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function SurveySelectorSkeleton() {
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-40" />
      </div>
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
