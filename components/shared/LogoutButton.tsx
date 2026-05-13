"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LogOut, Loader2 } from "lucide-react";
import { useSetupStore } from "@/store/setup-store";
import { useSurveyStore } from "@/store/survey-store";
import { useGenerationStore } from "@/store/generation-store";
import { useWizardStore } from "@/store/wizard-store";
import { usePersonasStore } from "@/store/personas-store";
import { useResponsesStore } from "@/store/responses-store";
import { clearAllQuestionCache } from "@/lib/storage/questions-cache";
import { clearAllProfiles } from "@/lib/storage/profiles";
import { resetCelebration } from "@/lib/effects/celebrate";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function LogoutButton() {
  const router = useRouter();
  const resetSetup = useSetupStore((s) => s.reset);
  const resetSurveys = useSurveyStore((s) => s.reset);
  const resetGeneration = useGenerationStore((s) => s.resetDraft);
  const resetWizard = useWizardStore((s) => s.reset);
  const resetPersonas = usePersonasStore((s) => s.reset);
  const resetResponses = useResponsesStore((s) => s.reset);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  async function handleLogout() {
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      // Clear all in-memory state and persisted client storage so the next
      // sign-in starts clean — no stale data leaks into a fresh session
      // against a different workspace.
      resetSetup();
      resetSurveys();
      resetGeneration();
      resetWizard();
      resetPersonas();
      resetResponses();
      // Re-arm the first-push confetti so the next session gets its own.
      resetCelebration();
      await Promise.all([clearAllQuestionCache(), clearAllProfiles()]);
      // sessionStorage cleanup for the persisted generation draft + personas + responses.
      try {
        window.sessionStorage.removeItem("plumage:generation-draft:v1");
        window.sessionStorage.removeItem("plumage:personas:v1");
        window.sessionStorage.removeItem("plumage:responses:v1");
      } catch {
        /* ignore */
      }
      router.replace("/login");
      router.refresh();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      {/* Icon-only trigger keeps the header compact. The confirmation dialog
          itself spells out exactly what's about to happen, so no surface-
          level label is needed. Tooltip handles hover discoverability. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label="Sign out"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              <span className="sr-only">Sign out</span>
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Sign out</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out and clear connections?</AlertDialogTitle>
          <AlertDialogDescription>
            You&apos;ll need to re-enter your SurveySparrow and LLM API keys after signing
            back in. Any unsaved configuration in this tab will be lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Prevent Radix from auto-closing before our async handler finishes
              // — we close manually inside handleLogout.
              e.preventDefault();
              void handleLogout();
            }}
            disabled={busy}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? "Signing out..." : "Sign out"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
