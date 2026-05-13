"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGenerationStore, isDraftDirty } from "@/store/generation-store";
import { SaveProfileDialog } from "./SaveProfileDialog";
import { LoadProfileDialog } from "./LoadProfileDialog";
import {
  Save,
  ChevronDown,
  FolderOpen,
  CopyPlus,
  RotateCcw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

export function ProfileBar() {
  const draft = useGenerationStore((s) => s.draft);
  const loadedProfile = useGenerationStore((s) => s.loadedProfile);
  const resetDraft = useGenerationStore((s) => s.resetDraft);
  const clearLoadedSource = useGenerationStore((s) => s.clearLoadedSource);

  const dirty = isDraftDirty(draft, loadedProfile);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveAsNew, setSaveAsNew] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);

  // Cmd/Ctrl+S → save profile (intercepts the browser's "save page" prompt).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        setSaveAsNew(false);
        setSaveOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function openSave(asNew: boolean) {
    setSaveAsNew(asNew);
    setSaveOpen(true);
  }

  function handleResetDraft() {
    if (
      !confirm("Reset the configuration draft to factory defaults? This won't delete saved profiles.")
    ) {
      return;
    }
    resetDraft();
    toast.success("Draft reset to defaults");
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card/40 p-3">
        <div className="flex min-w-0 items-center gap-2">
          {loadedProfile ? (
            <>
              <Sparkles className="h-4 w-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium" title={loadedProfile.name}>
                    {loadedProfile.name}
                  </span>
                  {dirty ? (
                    <Badge variant="warning" className="text-[10px]">
                      Unsaved changes
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] font-normal">
                      Saved
                    </Badge>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Loaded profile · changes affect only the current draft until you save.
                </div>
              </div>
            </>
          ) : (
            <>
              <Settings2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-sm font-medium">Unsaved configuration</div>
                <div className="text-[11px] text-muted-foreground">
                  Save as a profile to reuse this configuration for future demos.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={() => setLoadOpen(true)}>
            <FolderOpen className="h-3.5 w-3.5" />
            Load
          </Button>
          <Button size="sm" onClick={() => openSave(false)}>
            <Save className="h-3.5 w-3.5" />
            {loadedProfile ? "Save changes" : "Save profile"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More profile actions">
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs">Profiles</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => openSave(true)}>
                <CopyPlus className="h-3.5 w-3.5" />
                Save as new...
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/profiles">
                  <Settings2 className="h-3.5 w-3.5" />
                  Manage all profiles
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={clearLoadedSource} disabled={!loadedProfile}>
                Detach loaded profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleResetDraft}>
                <RotateCcw className="h-3.5 w-3.5" />
                Reset draft to defaults
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <SaveProfileDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        mode={saveAsNew ? "as-new" : "auto"}
      />
      <LoadProfileDialog open={loadOpen} onOpenChange={setLoadOpen} />
    </>
  );
}
