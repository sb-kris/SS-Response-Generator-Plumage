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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/utils/format-date";
import {
  listProfilesShallow,
  getProfile,
  type ProfileSummary,
} from "@/lib/storage/profiles";
import { useGenerationStore, isDraftDirty } from "@/store/generation-store";
import { toast } from "sonner";
import { FileText, FolderOpen } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LoadProfileDialog({ open, onOpenChange }: Props) {
  const draft = useGenerationStore((s) => s.draft);
  const loadedProfile = useGenerationStore((s) => s.loadedProfile);
  const loadProfile = useGenerationStore((s) => s.loadProfile);

  const [list, setList] = useState<ProfileSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmingDirty, setConfirmingDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setConfirmingDirty(false);
    void listProfilesShallow().then(setList);
  }, [open]);

  const dirty = isDraftDirty(draft, loadedProfile);

  async function handleConfirmLoad() {
    if (!selectedId) return;
    const profile = await getProfile(selectedId);
    if (!profile) {
      toast.error("Profile not found", {
        description: "It may have been deleted since the list was loaded.",
      });
      return;
    }
    loadProfile(profile);
    toast.success(`Loaded "${profile.name}"`);
    onOpenChange(false);
  }

  function handleLoadClick() {
    if (!selectedId) return;
    if (dirty) {
      setConfirmingDirty(true);
      return;
    }
    void handleConfirmLoad();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            Load profile
          </DialogTitle>
          <DialogDescription>
            Replace the current configuration draft with a saved profile. API
            keys are not part of the profile.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-2">
          <ScrollArea className="max-h-[360px]">
            <div className="px-2">
              {list === null && <ListSkeleton />}
              {list && list.length === 0 && (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  <FileText className="mx-auto mb-2 h-6 w-6 opacity-60" />
                  No profiles saved yet. Create one with <strong>Save profile</strong>.
                </div>
              )}
              {list && list.length > 0 && (
                <ul className="space-y-1">
                  {list.map((p) => {
                    const isSelected = selectedId === p.id;
                    const isCurrent = loadedProfile?.id === p.id;
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(p.id)}
                          className={cn(
                            "flex w-full items-start justify-between gap-3 rounded-md border p-3 text-left transition-colors",
                            isSelected
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-accent/50",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-medium">{p.name}</span>
                              {isCurrent && (
                                <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-medium text-success">
                                  Loaded
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Updated {formatRelativeDate(p.updatedAt)} · created{" "}
                              {formatRelativeDate(p.createdAt)}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </ScrollArea>
        </div>

        {confirmingDirty && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            You have unsaved changes in the current draft. Loading a different
            profile will discard them.
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {confirmingDirty ? (
            <Button onClick={() => void handleConfirmLoad()}>
              Discard &amp; load
            </Button>
          ) : (
            <Button onClick={handleLoadClick} disabled={!selectedId}>
              Load profile
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ListSkeleton() {
  return (
    <ul className="space-y-1">
      {Array.from({ length: 4 }).map((_, i) => (
        <li key={i} className="space-y-2 rounded-md border p-3">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </li>
      ))}
    </ul>
  );
}
