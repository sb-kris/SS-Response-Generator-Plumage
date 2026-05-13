"use client";

import Link from "next/link";
import { ConnectionForm } from "@/components/setup/ConnectionForm";
import { LLMConfigForm } from "@/components/setup/LLMConfigForm";
import { useSetupStore } from "@/store/setup-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Sparkles, ShieldCheck, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function SetupPage() {
  const ssOk = useSetupStore((s) => s.ssConnection.status === "ok");
  const llmOk = useSetupStore((s) => s.llmConnection.status === "ok");
  const bothConnected = ssOk && llmOk;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Setup</h1>
          {bothConnected && (
            <Badge variant="success" className="gap-1">
              <Sparkles className="h-3 w-3" />
              Ready
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground">
          Connect your SurveySparrow workspace and choose an AI provider to generate
          realistic survey responses. Verify both connections, then head to Generate to
          select a survey and create your demo data.
        </p>
      </header>

      <Alert>
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>API keys never leave this tab.</AlertTitle>
        <AlertDescription>
          Keys are kept in browser memory only — refresh the page and they&apos;re gone. The
          server proxies requests with the keys you provide and never persists them.
        </AlertDescription>
      </Alert>

      <ConnectionForm />
      <LLMConfigForm />

      {bothConnected && (
        <Alert variant="success">
          <Sparkles className="h-4 w-4" />
          <AlertTitle>You&apos;re all set.</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Both connections look healthy. Head to Generate to pick a survey and
              preview its questions.
            </p>
            <Button asChild size="sm" className="bg-success text-success-foreground hover:bg-success/90">
              <Link href="/generate">
                Continue to Generate
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
