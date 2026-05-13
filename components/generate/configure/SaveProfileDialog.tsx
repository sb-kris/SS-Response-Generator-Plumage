"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useGenerationStore } from "@/store/generation-store";
import { createProfile, updateProfile, resolveUniqueName } from "@/lib/storage/profiles";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * "as-new" forces creating a new profile even if one is loaded — used by
   * the "Save as new" action. When false, saves over the loaded profile if
   * present, otherwise creates a new one.
   */
  mode: "as-new" | "auto";
}

export function SaveProfileDialog({ open, onOpenChange, mode }: Props) {
  const draft = useGenerationStore((s) => s.draft);
  const loadedProfile = useGenerationStore((s) => s.loadedProfile);
  const markPristine = useGenerationStore((s) => s.markPristine);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOverwrite = mode === "auto" && Boolean(loadedProfile);

  // Seed the input with the current loaded name (for overwrite) or a sensible
  // default (when creating new).
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (isOverwrite && loadedProfile) {
      setName(loadedProfile.name);
    } else if (loadedProfile) {
      // "Save as new" off a loaded profile defaults to "<name> (copy)".
      void resolveUniqueName(`${loadedProfile.name} (copy)`).then(setName);
    } else {
      setName("");
    }
  }, [open, isOverwrite, loadedProfile]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isOverwrite && loadedProfile) {
        const next = await updateProfile(loadedProfile.id, draft, trimmed);
        markPristine({
          id: next.id,
          name: next.name,
          snapshot: structuredClone(draft),
        });
        toast.success("Profile updated", { description: next.name });
      } else {
        const next = await createProfile(trimmed, draft);
        markPristine({
          id: next.id,
          name: next.name,
          snapshot: structuredClone(draft),
        });
        toast.success("Profile saved", {
          description:
            next.name === trimmed
              ? next.name
              : `Saved as "${next.name}" (name was already taken).`,
        });
      }
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't save profile.";
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {isOverwrite ? "Update profile" : "Save profile"}
            </DialogTitle>
            <DialogDescription>
              {isOverwrite
                ? `Overwrite "${loadedProfile?.name}" with the current configuration. Saved profiles never include API keys.`
                : "Save the current configuration as a reusable profile. API keys are never saved."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="profile-name">Profile name</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nexora Demo, Acme Q4 Pitch"
              maxLength={80}
              disabled={busy}
              autoFocus
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            {!error && (
              <p className="text-xs text-muted-foreground">
                If the name is taken, we&apos;ll auto-suffix with &quot;(2)&quot;,
                &quot;(3)&quot;, etc.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy
                ? "Saving..."
                : isOverwrite
                  ? "Update"
                  : "Save profile"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
