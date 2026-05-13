"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { loggedFetch } from "@/store/api-logs-store";
import {
  extractQuestionDisplay,
  partitionQuestionsForGeneration,
  FALLBACK_TEXT,
  type Question,
  type QuestionDisplay,
} from "@/lib/surveysparrow/types";
import {
  getCachedQuestions,
  setCachedQuestions,
  invalidateQuestionsCache,
} from "@/lib/storage/questions-cache";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  RefreshCw,
  ChevronsRight,
  Image as ImageIcon,
  Bug,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  getQuestionTypeMeta,
  summarizeBuckets,
} from "@/lib/surveysparrow/question-types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface FetchQuestionsResponse {
  ok: boolean;
  questions?: Question[];
  count?: number;
  truncated?: boolean;
  error?: string;
  status?: number;
}

export function QuestionPreview() {
  const ssRegion = useSetupStore((s) => s.surveySparrow.region);
  const ssApiKey = useSetupStore((s) => s.surveySparrow.apiKey);

  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const questions = useSurveyStore((s) => s.questions);
  const fromCache = useSurveyStore((s) => s.questionsFromCache);
  const setQuestions = useSurveyStore((s) => s.setQuestions);

  const lastFetchedIdRef = useRef<number | null>(null);

  // Fetch (with cache lookup) every time the selected survey changes.
  useEffect(() => {
    if (selectedSurveyId === null) {
      lastFetchedIdRef.current = null;
      return;
    }
    if (lastFetchedIdRef.current === selectedSurveyId && questions.status === "ok") {
      return;
    }
    lastFetchedIdRef.current = selectedSurveyId;
    void load(selectedSurveyId, /* forceRefresh */ false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSurveyId]);

  async function load(surveyId: number, forceRefresh: boolean) {
    setQuestions({ status: "loading", error: null });

    if (!forceRefresh) {
      const cached = await getCachedQuestions(ssRegion, ssApiKey, surveyId);
      if (cached) {
        setQuestions(
          {
            status: "ok",
            data: cached,
            error: null,
            fetchedAt: Date.now(),
          },
          /* fromCache */ true,
        );
        return;
      }
    }

    try {
      const res = await loggedFetch(
        "/api/surveysparrow/questions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: ssRegion, apiKey: ssApiKey, surveyId }),
        },
        { kind: "internal", provider: "plumage", contextLabel: `survey-${surveyId}` },
      );
      const json = (await res.json()) as FetchQuestionsResponse;
      if (!json.ok) {
        setQuestions({
          status: "error",
          error: json.error ?? `Failed to load questions (HTTP ${res.status})`,
          data: null,
          fetchedAt: null,
        });
        toast.error("Failed to load questions", {
          description: json.error ?? "Unknown error",
        });
        return;
      }
      const list = json.questions ?? [];
      setQuestions(
        {
          status: "ok",
          data: list,
          truncated: json.truncated,
          fetchedAt: Date.now(),
          error: null,
        },
        /* fromCache */ false,
      );
      void setCachedQuestions(ssRegion, ssApiKey, surveyId, list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setQuestions({ status: "error", error: msg, data: null, fetchedAt: null });
      toast.error("Network error loading questions", { description: msg });
    }
  }

  async function refresh() {
    if (selectedSurveyId === null) return;
    await invalidateQuestionsCache(ssRegion, ssApiKey, selectedSurveyId);
    await load(selectedSurveyId, true);
  }

  const partition = useMemo(() => {
    const all = questions.data ?? [];
    return partitionQuestionsForGeneration(all);
  }, [questions.data]);

  // Pair the kept Question with its display projection so the debug panel can
  // show the raw payload for the same item.
  const rows = useMemo(
    () =>
      partition.kept.map((q) => ({
        raw: q,
        display: extractQuestionDisplay(q),
      })),
    [partition.kept],
  );

  // True if any kept question lacks resolvable text — likely a schema mismatch
  // we should surface so the user can paste me the raw JSON.
  const hasMissingText = useMemo(
    () => rows.some((r) => r.display.text === FALLBACK_TEXT),
    [rows],
  );

  const bucketSummary = useMemo(
    () => summarizeBuckets(rows.map((r) => ({ type: r.display.type }))),
    [rows],
  );

  if (selectedSurveyId === null) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <ChevronsRight className="h-6 w-6 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">No survey selected</div>
            <div className="text-xs text-muted-foreground">
              Pick one above to preview its questions.
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (questions.status === "loading") return <QuestionsSkeleton />;

  if (questions.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Couldn&apos;t load questions</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{questions.error ?? "Unknown error"}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={refresh}
            className="bg-background"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              Questions
              <Badge variant="secondary">{rows.length}</Badge>
              {fromCache && (
                <Badge variant="outline" className="gap-1 font-normal">
                  <Database className="h-3 w-3" />
                  cached
                </Badge>
              )}
            </CardTitle>
            {bucketSummary.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                {bucketSummary.map((b, i) => (
                  <span key={b.bucket} className="inline-flex items-center gap-1.5">
                    {i > 0 && <span aria-hidden>·</span>}
                    <span>
                      <span className="font-medium text-foreground">{b.count}</span>{" "}
                      {b.label}
                    </span>
                  </span>
                ))}
              </div>
            )}
            <CardDescription>
              Click a question to see its choices and metadata. The Configure step lets
              you set tone, distribution, and overrides per question.
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} title="Refetch from SurveySparrow">
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {partition.skippedImageOnly > 0 && (
          <Alert>
            <ImageIcon className="h-4 w-4" />
            <AlertDescription>
              Hid {partition.skippedImageOnly} image-based{" "}
              {partition.skippedImageOnly === 1 ? "question" : "questions"} — Plumage
              generates text responses only.
            </AlertDescription>
          </Alert>
        )}

        {hasMissingText && (
          <Alert variant="warning">
            <Bug className="h-4 w-4" />
            <AlertTitle>Some question text didn&apos;t come through</AlertTitle>
            <AlertDescription>
              Expand any &quot;{FALLBACK_TEXT}&quot; row below and click{" "}
              <strong>Show raw JSON</strong> — paste the payload to me and I&apos;ll
              widen the field detection.
            </AlertDescription>
          </Alert>
        )}

        {rows.length === 0 ? (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              No usable questions in this survey. (Image-only questions are excluded.)
            </AlertDescription>
          </Alert>
        ) : (
          <Accordion type="multiple" className="w-full">
            {rows.map(({ raw, display }, idx) => (
              <QuestionRow key={display.id} q={display} raw={raw} index={idx + 1} />
            ))}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}

function QuestionRow({
  q,
  raw,
  index,
}: {
  q: QuestionDisplay;
  raw: Question;
  index: number;
}) {
  const meta = getQuestionTypeMeta(q.type);
  const Icon = meta.icon;
  const missingText = q.text === FALLBACK_TEXT;
  const skippedDuringGeneration = !meta.answerable;
  return (
    <AccordionItem value={String(q.id)} className="last:border-b-0">
      <AccordionTrigger>
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium",
              skippedDuringGeneration && "opacity-60",
            )}
          >
            {index}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div
              className={cn(
                "line-clamp-2 break-words text-sm",
                missingText && "text-warning",
                skippedDuringGeneration && !missingText && "text-muted-foreground",
              )}
            >
              {q.text}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="gap-1 text-[10px] font-normal">
                <Icon className="h-3 w-3" />
                {meta.label}
              </Badge>
              {q.required && !skippedDuringGeneration && (
                <Badge
                  variant="outline"
                  className="border-warning/50 text-[10px] font-normal text-warning"
                >
                  required
                </Badge>
              )}
              {skippedDuringGeneration && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="cursor-help border-muted-foreground/30 text-[10px] font-normal text-muted-foreground"
                    >
                      Skipped during generation
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    This question type isn&apos;t generated by the LLM — it&apos;ll
                    be skipped or auto-filled from the persona&apos;s metadata.
                  </TooltipContent>
                </Tooltip>
              )}
              {q.rows && (
                <span className="text-xs text-muted-foreground">
                  · {q.rows.length} {q.rows.length === 1 ? "row" : "rows"}
                </span>
              )}
              {q.choices && (
                <span className="text-xs text-muted-foreground">
                  · {q.choices.length} {q.choices.length === 1 ? "choice" : "choices"}
                </span>
              )}
              {q.scalePoints && (
                <span className="text-xs text-muted-foreground">
                  · {q.scalePoints.length} scale points
                </span>
              )}
              {q.scale && !q.scalePoints && (
                <span className="text-xs text-muted-foreground">
                  · scale {q.scale.min}–{q.scale.max}
                </span>
              )}
              {q.isFreeText && !skippedDuringGeneration && (
                <span className="text-xs text-muted-foreground">· free text</span>
              )}
            </div>
          </div>
        </div>
      </AccordionTrigger>
      <AccordionContent>
        <div className="ml-10 space-y-3 text-sm">
          {q.description && (
            <div className="text-muted-foreground">{q.description}</div>
          )}

          {q.rows && q.rows.length > 0 && (
            <ChoiceList title="Rows" items={q.rows.map((r) => r.text)} />
          )}

          {q.choices && q.choices.length > 0 && (
            <ChoiceList title="Choices" items={q.choices.map((c) => c.text)} />
          )}

          {q.scalePoints && q.scalePoints.length > 0 && (
            <ChoiceList
              title="Scale points"
              items={q.scalePoints.map((s) => s.text)}
            />
          )}

          {q.scale && !q.scalePoints && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Scale</div>
              <div className="flex items-center gap-2">
                {Array.from({ length: q.scale.max - q.scale.min + 1 }).map((_, i) => (
                  <span
                    key={i}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-card text-xs"
                  >
                    {q.scale!.min + i}
                  </span>
                ))}
              </div>
            </div>
          )}

          <Separator />
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>
              ID <code className="font-mono">{q.id}</code>
            </span>
            <span>
              Position <code className="font-mono">{q.position}</code>
            </span>
            <span>
              Type <code className="font-mono">{q.type}</code>
            </span>
          </div>

          <RawJsonToggle q={raw} highlight={missingText} />
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function RawJsonToggle({ q, highlight }: { q: Question; highlight: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => JSON.stringify(q, null, 2), [q]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1 px-2 text-xs",
            highlight && "text-warning hover:text-warning",
          )}
          onClick={() => setOpen((o) => !o)}
        >
          <Bug className="h-3 w-3" />
          {open ? "Hide raw JSON" : "Show raw JSON"}
        </Button>
        {open && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={copy}
          >
            {copied ? "Copied!" : "Copy"}
          </Button>
        )}
      </div>
      {open && (
        <pre className="max-h-72 overflow-auto rounded-md border bg-muted/50 p-3 text-[11px] leading-relaxed">
          <code className="font-mono">{json}</code>
        </pre>
      )}
    </div>
  );
}

function ChoiceList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <ul className="space-y-1">
        {items.map((text, i) => (
          <li key={i} className="flex items-start gap-2 break-words">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuestionsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-3 w-72" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b pb-3 last:border-b-0">
            <Skeleton className="h-7 w-7 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

