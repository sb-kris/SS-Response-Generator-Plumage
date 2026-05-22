"use client";

import { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { cn } from "@/lib/utils";
import { useResponsesStore } from "@/store/responses-store";
import { usePersonasStore } from "@/store/personas-store";
import { useSurveyStore } from "@/store/survey-store";
import { useGenerationStore } from "@/store/generation-store";
import { LANGUAGES_BY_CODE } from "@/lib/utils/language-geography";
import { summarizeResponses } from "@/lib/generation/response-types";
import type { Persona } from "@/lib/generation/persona-types";
import type { GeneratedResponse } from "@/lib/generation/response-types";
import { buildCsvRows, validateForCsvExport, buildCsvFilename } from "@/lib/export/csv-exporter";
import { MAX_CSV_ROWS } from "@/lib/export/csv-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { TimelineScrubber } from "./TimelineScrubber";
import { SpeakerButton } from "@/components/shared/SpeakerButton";
import { replayCelebration } from "@/lib/effects/celebrate";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Download,
  Info,
  RefreshCw,
  Send,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import type { GenerateResponsesHookState } from "./useGenerateResponses";
import {
  useColumnSort,
  useSingleFilter,
  type SortColumn,
} from "../shared/useTableControls";
import { FilterChips, SortHeader } from "../shared/TableControls";

// State C — preview card shown after generation completes.
//
// Responses are collapsed by default. The table renders a fixed-height
// scrollable viewport so large batches (hundreds–thousands) don't blow out
// the page. "Load more" pages in 25 rows at a time rather than dumping all
// DOM nodes at once.

const PAGE_SIZE = 25;

// Sortable column keys for the response table. Typed as a union so the
// sort state can't drift from real column ids.
type ResponseColKey =
  | "index"
  | "name"
  | "language"
  | "country"
  | "sentiment"
  | "answerCount";

interface Props {
  gen: GenerateResponsesHookState;
  onPush: () => void;
}

export function BasicPreviewCard({ gen, onPush }: Props) {
  const responses = useResponsesStore((s) => s.responses);
  const warnings = useResponsesStore((s) => s.progress.warnings);
  const reset = useResponsesStore((s) => s.reset);
  const pushStatus = useResponsesStore((s) => s.pushStatus);
  const personas = usePersonasStore((s) => s.personas);
  const surveys = useSurveyStore((s) => s.surveys.data);
  const selectedSurveyId = useSurveyStore((s) => s.selectedSurveyId);
  const questions = useSurveyStore((s) => s.questions.data);
  const draft = useGenerationStore((s) => s.draft);
  const { start } = gen;

  const summary = useMemo(
    () => summarizeResponses(responses, personas),
    [responses, personas],
  );

  const personasById = useMemo(
    () => new Map(personas.map((p) => [p.id, p] as const)),
    [personas],
  );

  // Push-state helpers — computed once here and reused in the header button,
  // the status banner, and the bottom action strip.
  const pushedCount = responses.filter((r) => r.status === "pushed").length;
  const failedCount = responses.filter((r) => r.status === "failed").length;
  const allPushed = pushedCount > 0 && pushedCount === responses.length;
  const partialPushed = pushedCount > 0 && pushedCount < responses.length;
  const remainingForPush = responses.length - pushedCount;
  const pushIsRunning = pushStatus === "running";

  // When the user has navigated back to preview during a push, the button
  // re-enters the push view (the hook is still running on the parent —
  // returning here just makes progress visible again).
  const pushButtonLabel = pushIsRunning
    ? "View push progress…"
    : allPushed
      ? "Pushed · view details"
      : partialPushed
        ? `Continue push (${remainingForPush.toLocaleString()})`
        : "Push to SurveySparrow";
  const PushIcon = pushIsRunning ? Send : allPushed ? CheckCircle2 : Send;

  // Card starts expanded after generation completes so users see their results
  // immediately without an extra click. They can still collapse if they want.
  const [cardExpanded, setCardExpanded] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── Time Machine state ─────────────────────────────────────────────────────
  //
  // playheadMs lives here (not in TimelineScrubber) so the table filter and
  // the scrubber share the same source of truth. It defaults to the last
  // response's generatedAt — i.e. "everything visible, scrub backward to
  // replay." Initialising at the start would show an empty table by default,
  // which is jarring.
  const lastResponseAt =
    responses.length > 0 ? responses[responses.length - 1]!.generatedAt : 0;
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [playheadMs, setPlayheadMs] = useState<number>(lastResponseAt);
  const [syncTable, setSyncTable] = useState(true);

  // When the response set changes (e.g. a re-generation), re-anchor the
  // playhead to the new tail. We do this via effect because the responses
  // identity changes on every store mutation.
  useEffect(() => {
    setPlayheadMs(lastResponseAt);
  }, [lastResponseAt]);

  // ── CSV export ──────────────────────────────────────────────────────────────

  // Pre-flight warnings (computed lazily so they don't cost anything until needed).
  const csvWarnings = useMemo(
    () => (questions ? validateForCsvExport(responses, questions) : []),
    [responses, questions],
  );

  function handleDownloadCsv() {
    if (!questions || questions.length === 0) {
      toast.error("Questions not loaded", {
        description: "Cannot build CSV — survey questions are not available.",
      });
      return;
    }

    // Hard block on the 5 000-row limit.
    if (responses.length > MAX_CSV_ROWS) {
      toast.error("Too many responses for CSV import", {
        description: `CSV import is limited to 5,000 rows. You have ${responses.length.toLocaleString()}. Generate fewer responses or split into batches.`,
      });
      return;
    }

    const survey = surveys?.find((s) => s.id === selectedSurveyId);
    if (!survey) {
      toast.error("Survey not found — cannot build filename.");
      return;
    }

    try {
      const { headers, rows } = buildCsvRows(
        responses,
        personas,
        survey,
        questions,
        draft,
      );

      const csv = Papa.unparse({ fields: headers, data: rows });

      // Trigger browser download.
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = buildCsvFilename(survey.name);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success(`CSV downloaded`, {
        description: `${rows.length.toLocaleString()} rows · ${headers.length} columns`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error("CSV export failed", { description: msg });
    }
  }

  // Table feed — when the Time Machine is expanded AND "Sync table" is on,
  // filter responses by playheadMs so the table mirrors the timeline.
  // Otherwise show everything.
  const filteredResponses = useMemo(() => {
    if (!timelineExpanded || !syncTable) return responses;
    return responses.filter((r) => r.generatedAt <= playheadMs);
  }, [responses, timelineExpanded, syncTable, playheadMs]);

  // ── Sort + filter for the response table ─────────────────────────────
  // Column accessors look up the persona for each response (responses
  // store only persona ID, not the full persona). personasById is
  // already memoised above so this is O(1) per row.
  const RESPONSE_COLUMNS: ReadonlyArray<SortColumn<GeneratedResponse, ResponseColKey>> = useMemo(
    () => [
      { key: "index",     accessor: (r) => (personasById.get(r.personaId)?.index ?? 0) },
      { key: "name",      accessor: (r) => r.personaName },
      { key: "language",  accessor: (r) => personasById.get(r.personaId)?.language ?? "" },
      { key: "country",   accessor: (r) => personasById.get(r.personaId)?.countryName ?? "" },
      { key: "sentiment", accessor: (r) => {
          const s = personasById.get(r.personaId)?.sentimentArchetype;
          return s === "promoter" ? 0 : s === "passive" ? 1 : 2;
        } },
      { key: "answerCount", accessor: (r) => Object.keys(r.answers).length },
    ],
    [personasById],
  );

  const { sort, toggleSort, sortRows } = useColumnSort<GeneratedResponse, ResponseColKey>(
    RESPONSE_COLUMNS,
  );
  const sentimentFilter = useSingleFilter<"promoter" | "passive" | "detractor">();

  const sentimentCounts = useMemo(() => {
    let promoter = 0, passive = 0, detractor = 0;
    for (const r of responses) {
      const s = personasById.get(r.personaId)?.sentimentArchetype;
      if (s === "promoter") promoter++;
      else if (s === "passive") passive++;
      else if (s === "detractor") detractor++;
    }
    return { promoter, passive, detractor };
  }, [responses, personasById]);

  // Filter → sort. Time-machine filter is already applied to `filteredResponses`
  // so we layer sentiment + sort on top of that.
  const displayedResponses = useMemo(() => {
    const matched = filteredResponses.filter((r) => {
      const s = personasById.get(r.personaId)?.sentimentArchetype ?? null;
      return sentimentFilter.match(s);
    });
    return sortRows(matched);
  }, [filteredResponses, personasById, sentimentFilter, sortRows]);

  const visible = displayedResponses.slice(0, visibleCount);
  const remaining = displayedResponses.length - visibleCount;

  return (
    <div className="space-y-4">
      <Card className="card-organic-static">
        {/* Clickable header toggles the card body */}
        <CardHeader
          className="cursor-pointer select-none"
          onClick={() => setCardExpanded((v) => !v)}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
              <CardTitle className="truncate">
                <AnimatedNumber value={responses.length} /> responses generated
              </CardTitle>
              {/* Replay the celebration on demand — same handle as the
                  speaker on the push-complete alert. Sized to sit on the
                  title baseline without disrupting the line height.
                  stopPropagation prevents the parent header's onClick from
                  also firing (which would toggle the card collapsed). */}
              <SpeakerButton
                onPlay={(e) => {
                  e.stopPropagation();
                  void replayCelebration();
                }}
                label="Replay celebration sound"
                className="h-9 w-9 shrink-0"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownloadCsv();
                }}
                disabled={responses.length === 0}
                className="gap-1.5"
              >
                <Download className="h-3.5 w-3.5" />
                Download CSV
              </Button>
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation(); // don't toggle card collapse
                  onPush();
                }}
                className="gap-1.5"
              >
                <PushIcon className="h-3.5 w-3.5" />
                {pushButtonLabel}
              </Button>
              <ChevronsUpDown className="h-4 w-4 text-muted-foreground" aria-hidden />
            </div>
          </div>
          <CardDescription>
            {cardExpanded
              ? "Click a row to inspect the raw answer JSON."
              : "Click to expand and inspect responses, or use the Push button above."}
          </CardDescription>
        </CardHeader>

        {cardExpanded && <CardContent className="space-y-5">
          {/* Stats grid — alternating organic / mirror corners create rhythm */}
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              className="card-organic-static"
              title="Sentiment"
              primaryNode={
                <span className="flex items-baseline gap-1">
                  <AnimatedNumber value={summary.bySentiment.promoter} />
                  <span className="text-muted-foreground">/</span>
                  <AnimatedNumber value={summary.bySentiment.passive} />
                  <span className="text-muted-foreground">/</span>
                  <AnimatedNumber value={summary.bySentiment.detractor} />
                </span>
              }
              secondary="Promoter · Passive · Detractor"
            />
            <StatTile
              className="card-organic-static-mirror"
              title="Avg NPS"
              primaryNode={
                summary.averageNps != null ? (
                  <AnimatedNumber
                    value={summary.averageNps}
                    format={(n) => n.toFixed(1)}
                  />
                ) : (
                  <>—</>
                )
              }
              secondary={summary.averageNps != null ? "Across all NPS questions" : "No NPS questions"}
            />
            <StatTile
              className="card-organic-static"
              title="Avg CSAT"
              primaryNode={
                summary.averageCsat != null ? (
                  <AnimatedNumber
                    value={summary.averageCsat}
                    format={(n) => n.toFixed(1)}
                  />
                ) : (
                  <>—</>
                )
              }
              secondary={summary.averageCsat != null ? "Across all CSAT questions" : "No CSAT questions"}
            />
          </div>

          {warnings.length > 0 && (
            <Alert variant="warning">
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>
                {warnings.length} persona{warnings.length === 1 ? "" : "s"} fell back to best-effort answers
              </AlertTitle>
              <AlertDescription className="space-y-1">
                {warnings.slice(0, 3).map((w, i) => (
                  <div key={i} className="text-xs">
                    <span className="font-medium">{w.personaName}</span>: {w.message}
                  </div>
                ))}
                {warnings.length > 3 && (
                  <div className="text-[10px] text-muted-foreground">
                    (+{warnings.length - 3} more — expand a row to see the partial answers)
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Push-status banner — shown when returning to preview after a push */}
          {(pushedCount > 0 || failedCount > 0) && (
            <Alert>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              <AlertTitle>
                {pushedCount.toLocaleString()} pushed
                {failedCount > 0 ? ` · ${failedCount} failed` : ""}
              </AlertTitle>
              <AlertDescription>
                {failedCount > 0
                  ? "Some responses didn't make it to SurveySparrow. Use Push to retry failed ones."
                  : "All responses are live in your SurveySparrow workspace's Responses tab."}
              </AlertDescription>
            </Alert>
          )}

          {/* Filter chip row — sentiment only for now. Hidden when there
              are no responses to filter, or when there's only one sentiment
              category present (keeps the surface clean). */}
          {responses.length > 1 && (
            <FilterChips
              label="Sentiment"
              value={sentimentFilter.value}
              onChange={sentimentFilter.setValue}
              options={[
                { value: "all",       label: "All",       count: responses.length },
                { value: "promoter",  label: "Promoter",  count: sentimentCounts.promoter,  tone: "success" },
                { value: "passive",   label: "Passive",   count: sentimentCounts.passive,   tone: "neutral" },
                { value: "detractor", label: "Detractor", count: sentimentCounts.detractor, tone: "danger" },
              ]}
            />
          )}

          {/* Response table — fixed-height scroll so large batches don't break layout */}
          <div className="rounded-lg border">
            <div className="max-h-[480px] overflow-y-auto overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
                  <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                    {/* Row-expander column — not sortable. */}
                    <th className="w-8 px-3 py-2"></th>
                    <SortHeader columnKey="index"       sort={sort} toggle={toggleSort}>#</SortHeader>
                    <SortHeader columnKey="name"        sort={sort} toggle={toggleSort}>Persona</SortHeader>
                    <SortHeader columnKey="language"    sort={sort} toggle={toggleSort}>Lang</SortHeader>
                    <SortHeader columnKey="country"     sort={sort} toggle={toggleSort}>Country</SortHeader>
                    <SortHeader columnKey="sentiment"   sort={sort} toggle={toggleSort}>Sentiment</SortHeader>
                    <SortHeader columnKey="answerCount" sort={sort} toggle={toggleSort}># Answers</SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-6 text-center text-xs text-muted-foreground">
                        No responses match the current filters.
                      </td>
                    </tr>
                  ) : (
                    visible.map((r, idx) => (
                      <ResponseRow
                        key={r.id}
                        index={idx + 1}
                        response={r}
                        persona={personasById.get(r.personaId)}
                        expanded={expandedId === r.id}
                        onToggle={() =>
                          setExpandedId((cur) => (cur === r.id ? null : r.id))
                        }
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {remaining > 0 && (
              <div className="flex justify-center border-t bg-muted/20 p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  className="gap-1.5 text-xs"
                >
                  Load {Math.min(PAGE_SIZE, remaining).toLocaleString()} more
                  <span className="text-muted-foreground">
                    ({remaining.toLocaleString()} remaining)
                  </span>
                </Button>
              </div>
            )}
          </div>

          {/* ── Time Machine ────────────────────────────────────────────────
              Collapsed by default — opens via the "Replay generation" button
              below the table. Once expanded, it persists for the session and
              owns the playheadMs that drives the table sync. */}
          {!timelineExpanded ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTimelineExpanded(true)}
                className="gap-1.5"
              >
                <Clock className="h-3.5 w-3.5" />
                Replay generation
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ) : (
            <TimelineScrubber
              playheadMs={playheadMs}
              onPlayheadChange={setPlayheadMs}
              syncTable={syncTable}
              onSyncTableChange={setSyncTable}
              onCollapse={() => setTimelineExpanded(false)}
            />
          )}

        </CardContent>}

        {/* CSV pre-flight warnings — shown above action strip when present */}
        {csvWarnings.length > 0 && (
          <div className="space-y-2 border-t px-6 pt-4">
            {csvWarnings.map((w, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-warning"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{w.message}</span>
              </div>
            ))}
          </div>
        )}

        {/* Action strip — always visible regardless of collapse state */}
        <div className="flex flex-wrap items-center gap-2 border-t px-6 py-4">
          <Button size="lg" onClick={onPush} className="gap-2">
            <PushIcon className="h-4 w-4" />
            {pushButtonLabel}
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={handleDownloadCsv}
            disabled={responses.length === 0}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Download CSV
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={() => {
              reset();
              void start();
            }}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Re-generate
          </Button>
          <Button variant="ghost" size="lg" onClick={() => reset()}>
            Discard
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single row + JSON expansion
// ---------------------------------------------------------------------------

function ResponseRow({
  index,
  response,
  persona,
  expanded,
  onToggle,
}: {
  index: number;
  response: GeneratedResponse;
  persona: Persona | undefined;
  expanded: boolean;
  onToggle: () => void;
}) {
  const lang = persona ? LANGUAGES_BY_CODE[persona.language] : null;
  const langLabel = lang ? `${lang.flag} ${persona!.language.toUpperCase()}` : "—";
  const sentiment = persona?.sentimentArchetype;
  const country = persona?.countryName ?? "—";
  const answerCount = Object.keys(response.answers).length;

  return (
    <>
      <tr
        className="cursor-pointer border-t hover:bg-muted/40"
        onClick={onToggle}
      >
        <td className="px-3 py-2 align-middle">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </td>
        <td className="px-3 py-2 align-middle text-xs text-muted-foreground tabular-nums">
          {index}
        </td>
        <td className="px-3 py-2 align-middle">
          <div className="flex items-center gap-2.5">
            {/* Avatar — loaded lazily from DiceBear; no LLM token cost */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(response.personaId)}`}
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 shrink-0 rounded-full bg-muted"
              loading="lazy"
            />
            <div className="min-w-0">
              <div className="truncate font-medium">{response.personaName}</div>
              {persona && (
                <div className="truncate text-xs text-muted-foreground">
                  {persona.email}
                </div>
              )}
            </div>
          </div>
        </td>
        <td className="px-3 py-2 align-middle text-xs">{langLabel}</td>
        <td className="px-3 py-2 align-middle text-xs">{country}</td>
        <td className="px-3 py-2 align-middle">
          {sentiment && <SentimentBadge sentiment={sentiment} />}
        </td>
        <td className="px-3 py-2 align-middle text-xs tabular-nums">
          {answerCount}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t bg-muted/20">
          <td colSpan={7} className="px-3 py-3">
            <pre className="max-h-96 overflow-auto rounded-md border bg-background p-3 text-[11px] leading-relaxed">
              {JSON.stringify(response.answers, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function StatTile({
  title,
  primary,
  primaryNode,
  secondary,
  className,
}: {
  title: string;
  /** Plain-string primary (legacy). Prefer `primaryNode` for animated values. */
  primary?: string;
  /** React node — used when the primary value needs <AnimatedNumber> inside. */
  primaryNode?: React.ReactNode;
  secondary: string;
  /** Extra classes — used to pass card-organic-static* shape variants. */
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border bg-card/40 p-3", className)}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <p className="mt-1 truncate text-base font-semibold">
        {primaryNode ?? primary}
      </p>
      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
        {secondary}
      </p>
    </div>
  );
}

function SentimentBadge({
  sentiment,
}: {
  sentiment: Persona["sentimentArchetype"];
}) {
  const variant =
    sentiment === "promoter"
      ? "success"
      : sentiment === "detractor"
        ? "destructive"
        : "secondary";
  const label =
    sentiment === "promoter"
      ? "Promoter"
      : sentiment === "detractor"
        ? "Detractor"
        : "Passive";
  return (
    <Badge variant={variant} className="text-[10px]">
      {label}
    </Badge>
  );
}
