"use client";

import React, { useState } from "react";
import { useSetupStore } from "@/store/setup-store";
import { loggedFetch } from "@/store/api-logs-store";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ApiKeyInput } from "@/components/shared/ApiKeyInput";
import { ProviderIcon } from "@/components/shared/ProviderIcon";
import { playSuccessChime, playErrorChime } from "@/lib/effects/sound-effects";
import { ModelSelector } from "./ModelSelector";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  Info,
  Sparkles,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import {
  LLM_PROVIDERS,
  getProviderMeta,
  type LLMProvider,
} from "@/lib/llm/models";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Provider grid — compact card for each provider
// ---------------------------------------------------------------------------

/** Visually highlight ONE provider as "recommended for most SEs". Kept in
 *  sync with the cost-estimator's recommendation: Google Gemini is the
 *  cost-sensitive default surfaced to new SEs. We don't auto-switch the
 *  store's default provider — backward compatibility with existing Anthropic
 *  test flows matters more — we only surface the recommendation visually. */
const RECOMMENDED_PROVIDER: LLMProvider = "google";

interface ProviderCardProps {
  provider: LLMProvider;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

function ProviderCard({ provider, selected, disabled, onSelect }: ProviderCardProps) {
  const meta = getProviderMeta(provider);
  const isRecommended = provider === RECOMMENDED_PROVIDER;
  const hasRisk = Boolean(meta.riskNote);

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "relative flex flex-col gap-1.5 rounded-md border p-3 text-left text-sm transition-colors",
        selected
          ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/20"
          : "border-border bg-background hover:border-input hover:bg-accent",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn("flex items-center gap-2 text-sm font-semibold", meta.accentClass)}>
          <ProviderIcon provider={provider} className="h-4 w-4 -translate-y-px" />
          {meta.label}
        </span>
        {isRecommended && (
          <Badge
            variant="success"
            className="h-5 px-1.5 text-[10px] font-medium leading-none"
          >
            <Sparkles className="mr-0.5 h-2.5 w-2.5" />
            Recommended
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{meta.blurb}</p>
      {hasRisk && (
        <div className="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
          <ShieldAlert className="h-3 w-3" />
          <span>Use with care for sensitive context</span>
        </div>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Custom-model-ID input for OpenRouter
// ---------------------------------------------------------------------------

interface CustomModelIdRowProps {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

function CustomModelIdRow({
  id,
  label,
  value,
  onChange,
  disabled,
  placeholder,
}: CustomModelIdRowProps) {
  return (
    <div className="mt-2 space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "e.g. anthropic/claude-3.5-haiku"}
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        className="font-mono text-xs"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function LLMConfigForm() {
  const llm = useSetupStore((s) => s.llm);
  const setProvider = useSetupStore((s) => s.setLLMProvider);
  const setApiKey = useSetupStore((s) => s.setLLMApiKey);
  const setPersonaModel = useSetupStore((s) => s.setLLMPersonaModel);
  const setResponseModel = useSetupStore((s) => s.setLLMResponseModel);
  const setCustomPersonaModelId = useSetupStore((s) => s.setLLMCustomPersonaModelId);
  const setCustomResponseModelId = useSetupStore((s) => s.setLLMCustomResponseModelId);
  const connection = useSetupStore((s) => s.llmConnection);
  const setConnection = useSetupStore((s) => s.setLLMConnection);

  const validating = connection.status === "validating";
  const meta = getProviderMeta(llm.provider);
  const providerLabel = meta.label;

  // Whether we need (and have) a custom OpenRouter model ID for either kind.
  const personaNeedsCustomId =
    llm.provider === "openrouter" && llm.personaModel === "openrouter:custom";
  const responseNeedsCustomId =
    llm.provider === "openrouter" && llm.responseModel === "openrouter:custom";
  const customIdsSatisfied =
    (!personaNeedsCustomId || llm.customPersonaModelId.trim().length > 0) &&
    (!responseNeedsCustomId || llm.customResponseModelId.trim().length > 0);

  const canTest = !validating && llm.apiKey.trim().length > 0 && customIdsSatisfied;

  // Collapsible advanced notes (risk + free-tier warning, when present).
  const [notesOpen, setNotesOpen] = useState(false);

  async function handleTest() {
    setConnection({ status: "validating", error: null, detail: null });
    try {
      // Probe the persona model — it's typically the cheaper of the two and
      // any auth/model-availability error surfaces the same way as it would
      // for the response model.
      const res = await loggedFetch(
        "/api/llm/test-connection",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: llm.provider,
            apiKey: llm.apiKey,
            model: llm.personaModel,
            customModelId: personaNeedsCustomId ? llm.customPersonaModelId : undefined,
          }),
        },
        { kind: "internal", provider: "plumage", contextLabel: `llm-probe:${llm.provider}` },
      );
      const json = (await res.json()) as {
        ok: boolean;
        error?: string | null;
        sample?: string | null;
        model?: string;
      };
      if (!json.ok) {
        setConnection({
          status: "error",
          error: json.error ?? "Connection failed",
          detail: null,
        });
        toast.error(`${providerLabel} connection failed`, {
          description: json.error ?? "Unknown error",
        });
        void playErrorChime();
        return;
      }
      const detail = `Probe to ${json.model ?? llm.personaModel} succeeded${
        json.sample ? ` — got: "${json.sample.slice(0, 40)}"` : ""
      }`;
      setConnection({
        status: "ok",
        error: null,
        lastSuccessAt: Date.now(),
        detail,
      });
      toast.success(`${providerLabel} connected`, { description: detail });
      void playSuccessChime();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setConnection({ status: "error", error: msg, detail: null });
      toast.error("Network error", { description: msg });
      void playErrorChime();
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              LLM provider
              <ConnectionBadge status={connection.status} />
            </CardTitle>
            <CardDescription>
              Pick a provider, then choose models for persona synthesis and response
              generation. Cost-sensitive bulk runs? Try Gemini Flash-Lite. Polished
              executive demos? Anthropic or GPT-4o.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Provider grid — 2 cols on sm, 3 cols on lg. */}
        <div className="space-y-2">
          <Label>Provider</Label>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {LLM_PROVIDERS.map((p) => (
              <ProviderCard
                key={p}
                provider={p}
                selected={llm.provider === p}
                disabled={validating}
                onSelect={() => setProvider(p)}
              />
            ))}
          </div>
        </div>

        {/* API key */}
        <div className="space-y-2">
          <Label htmlFor="llm-api-key">{providerLabel} API key</Label>
          <ApiKeyInput
            id="llm-api-key"
            placeholder={placeholderForProvider(llm.provider)}
            value={llm.apiKey}
            onChange={setApiKey}
            disabled={validating}
          />
          <p className="text-xs text-muted-foreground">{meta.apiKeyHint}</p>

          {/* Provider risk + free-tier notes (collapsible if any). */}
          {(meta.riskNote || meta.freeTierWarning) && (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setNotesOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 text-left font-medium text-foreground"
                aria-expanded={notesOpen}
              >
                <span className="flex items-center gap-1.5">
                  <Info className="h-3.5 w-3.5" />
                  Advanced provider notes
                </span>
                <span className="text-muted-foreground">
                  {notesOpen ? "Hide" : "Show"}
                </span>
              </button>
              {notesOpen && (
                <div className="mt-2 space-y-1.5 text-muted-foreground">
                  {meta.riskNote && (
                    <div className="flex items-start gap-1.5">
                      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      <span>{meta.riskNote}</span>
                    </div>
                  )}
                  {meta.freeTierWarning && (
                    <div className="flex items-start gap-1.5">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{meta.freeTierWarning}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Model selectors */}
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-1">
            <ModelSelector
              id="persona-model"
              label="Persona model"
              description="Generates synthetic respondent profiles. Cheap & fast is fine here."
              kind="personas"
              provider={llm.provider}
              value={llm.personaModel}
              onChange={setPersonaModel}
              disabled={validating}
            />
            {personaNeedsCustomId && (
              <CustomModelIdRow
                id="persona-custom-id"
                label="OpenRouter model ID"
                value={llm.customPersonaModelId}
                onChange={setCustomPersonaModelId}
                disabled={validating}
                placeholder="e.g. anthropic/claude-3.5-haiku"
              />
            )}
          </div>
          <div className="space-y-1">
            <ModelSelector
              id="response-model"
              label="Response model"
              description="Writes each persona's answers. Quality matters more — pick a balanced model."
              kind="responses"
              provider={llm.provider}
              value={llm.responseModel}
              onChange={setResponseModel}
              disabled={validating}
            />
            {responseNeedsCustomId && (
              <CustomModelIdRow
                id="response-custom-id"
                label="OpenRouter model ID"
                value={llm.customResponseModelId}
                onChange={setCustomResponseModelId}
                disabled={validating}
                placeholder="e.g. anthropic/claude-3.5-sonnet"
              />
            )}
          </div>
        </div>

        {/* Connection feedback */}
        {connection.status === "error" && connection.error && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {connection.error}
            </AlertDescription>
          </Alert>
        )}
        {connection.status === "ok" && connection.detail && (
          <Alert variant="success">
            <AlertDescription className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
              {connection.detail}
            </AlertDescription>
          </Alert>
        )}

        {/* Test button row */}
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Test sends a tiny JSON probe to your persona model. Costs &lt; $0.0001.
          </p>
          <Button onClick={handleTest} disabled={!canTest}>
            {validating && <Loader2 className="h-4 w-4 animate-spin" />}
            {validating
              ? "Validating..."
              : connection.status === "ok"
                ? "Re-test connection"
                : "Test connection"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// API-key placeholders per provider
// ---------------------------------------------------------------------------

function placeholderForProvider(provider: LLMProvider): string {
  switch (provider) {
    case "anthropic":
      return "sk-ant-...";
    case "openai":
      return "sk-...";
    case "google":
      return "AIza...";
    case "deepseek":
      return "sk-...";
    case "groq":
      return "gsk_...";
    case "openrouter":
      return "sk-or-...";
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Connection badge
// ---------------------------------------------------------------------------

function ConnectionBadge({
  status,
}: {
  status: "idle" | "validating" | "ok" | "error";
}) {
  if (status === "ok") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> Connected
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" /> Failed
      </Badge>
    );
  }
  if (status === "validating") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="h-3 w-3 animate-spin" /> Validating
      </Badge>
    );
  }
  // Idle = no test attempted yet → "Not connected" reads as a status, not
  // a product-quality claim. The old "Not tested" label was misread by
  // SEs as "this feature is untested" rather than "this auth hasn't been
  // validated yet."
  return <Badge variant="outline">Not connected</Badge>;
}
