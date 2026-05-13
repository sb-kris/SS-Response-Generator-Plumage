"use client";

import { useGenerationStore } from "@/store/generation-store";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Lightbulb } from "lucide-react";

const MAX_CHARS = 2000;
const PLACEHOLDER = `e.g. Demo for Nexora Living, premium US smart home brand. Focus on installation experience, AI-powered features, and customer support quality. Customers are middle-to-upper-income homeowners aged 30–55.`;

export function ContextSection() {
  const useCase = useGenerationStore((s) => s.draft.useCase);
  const setUseCase = useGenerationStore((s) => s.setUseCase);

  const charCount = useCase.length;
  const overLimit = charCount > MAX_CHARS;
  const nearLimit = charCount > MAX_CHARS * 0.9 && !overLimit;

  return (
    <section id="context" className="scroll-mt-24">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Use case context</CardTitle>
          <CardDescription>
            Tell the LLM what this demo is about. Persona personalities, themes, and
            response tone are all anchored to this — be specific about the customer,
            product, and what you want the demo to highlight.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="use-case-textarea">Context</Label>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  overLimit && "text-destructive",
                  nearLimit && "text-warning",
                  !overLimit && !nearLimit && "text-muted-foreground",
                )}
                aria-live="polite"
              >
                {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()}
              </span>
            </div>
            <Textarea
              id="use-case-textarea"
              value={useCase}
              onChange={(e) => setUseCase(e.target.value.slice(0, MAX_CHARS + 200))}
              placeholder={PLACEHOLDER}
              className={cn(
                "min-h-[180px] resize-y",
                overLimit && "border-destructive focus-visible:ring-destructive",
              )}
              maxLength={MAX_CHARS + 200}
              spellCheck
            />
            {overLimit && (
              <p className="text-xs text-destructive">
                Trim {charCount - MAX_CHARS} characters — the model is more focused
                with a shorter brief anyway.
              </p>
            )}
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
              <Lightbulb className="h-3.5 w-3.5" />
              What to include
            </div>
            <ul className="list-disc space-y-0.5 pl-5">
              <li>Customer name + a one-line description of the product / brand</li>
              <li>What you want the demo to emphasize (positives, pain points, both)</li>
              <li>The respondent demographic (age, income, region — if relevant)</li>
              <li>Any specific themes you want responses to touch on</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
