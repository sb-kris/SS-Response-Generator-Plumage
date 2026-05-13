"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  listProfilesShallow,
  getProfile,
  duplicateProfile,
  deleteProfile,
  exportProfileAsJsonString,
  importProfileFromJson,
  type ProfileSummary,
} from "@/lib/storage/profiles";
import { useGenerationStore } from "@/store/generation-store";
import { formatRelativeDate } from "@/lib/utils/format-date";
import { toast } from "sonner";
import {
  Download,
  Upload,
  Copy,
  Trash2,
  MoreVertical,
  Sparkles,
  FilePlus,
  FolderOpen,
} from "lucide-react";

export default function ProfilesPage() {
  const router = useRouter();
  const loadProfile = useGenerationStore((s) => s.loadProfile);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [list, setList] = useState<ProfileSummary[] | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [busyDeleting, setBusyDeleting] = useState(false);

  async function refresh() {
    const next = await listProfilesShallow();
    setList(next);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const pendingDeleteName =
    list?.find((p) => p.id === pendingDeleteId)?.name ?? "";

  // ---- Actions ----
  async function handleLoad(id: string) {
    const profile = await getProfile(id);
    if (!profile) {
      toast.error("Profile not found", {
        description: "It may have been deleted in another tab.",
      });
      return;
    }
    loadProfile(profile);
    toast.success(`Loaded "${profile.name}"`);
    router.push("/generate");
  }

  async function handleDuplicate(id: string) {
    try {
      const dup = await duplicateProfile(id);
      toast.success(`Duplicated as "${dup.name}"`);
      await refresh();
    } catch (err) {
      toast.error("Couldn't duplicate", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  async function handleDelete(id: string) {
    setBusyDeleting(true);
    try {
      await deleteProfile(id);
      toast.success("Profile deleted");
      await refresh();
    } catch (err) {
      toast.error("Couldn't delete", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusyDeleting(false);
      setPendingDeleteId(null);
    }
  }

  async function handleExport(id: string) {
    const profile = await getProfile(id);
    if (!profile) {
      toast.error("Profile not found");
      return;
    }
    const json = exportProfileAsJsonString(profile);
    const filename = `plumage-profile-${profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.json`;
    triggerDownload(json, filename);
    toast.success("Exported", { description: filename });
  }

  function triggerImport() {
    fileInputRef.current?.click();
  }

  async function handleImportFile(file: File) {
    try {
      const text = await file.text();
      const result = await importProfileFromJson(text);
      if (!result.ok) {
        toast.error("Couldn't import profile", {
          description: result.errors?.join(", ") ?? "Unknown error",
        });
        return;
      }
      toast.success(`Imported "${result.profile?.name}"`);
      await refresh();
    } catch (err) {
      toast.error("Couldn't read file", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Demo profiles</h1>
          <p className="text-muted-foreground">
            Save reusable configurations for recurring demos. Profiles include
            context, themes, persona &amp; language mix, and per-question controls
            — never API keys.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          <Button variant="outline" size="sm" onClick={triggerImport}>
            <Upload className="h-3.5 w-3.5" />
            Import JSON
          </Button>
          <Button asChild size="sm">
            <Link href="/generate">
              <FilePlus className="h-3.5 w-3.5" />
              New profile
            </Link>
          </Button>
        </div>
      </header>

      {list === null ? (
        <ProfilesSkeleton />
      ) : list.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="space-y-2">
          {list.map((p) => (
            <ProfileRow
              key={p.id}
              summary={p}
              onLoad={() => handleLoad(p.id)}
              onDuplicate={() => handleDuplicate(p.id)}
              onDelete={() => setPendingDeleteId(p.id)}
              onExport={() => handleExport(p.id)}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(o) => !busyDeleting && !o && setPendingDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this profile?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{pendingDeleteName}&quot; will be permanently removed. Exported
              JSON copies (if any) are unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (pendingDeleteId) void handleDelete(pendingDeleteId);
              }}
              disabled={busyDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busyDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProfileRow({
  summary,
  onLoad,
  onDuplicate,
  onDelete,
  onExport,
}: {
  summary: ProfileSummary;
  onLoad: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  return (
    <li>
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span
                className="truncate text-sm font-medium"
                title={summary.name}
              >
                {summary.name}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              Updated {formatRelativeDate(summary.updatedAt)} · created{" "}
              {formatRelativeDate(summary.createdAt)}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" onClick={onLoad}>
              <FolderOpen className="h-3.5 w-3.5" />
              Load
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More actions">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onDuplicate}>
                  <Copy className="h-3.5 w-3.5" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onExport}>
                  <Download className="h-3.5 w-3.5" />
                  Export JSON
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={onDelete}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

function EmptyState() {
  return (
    <Alert>
      <Sparkles className="h-4 w-4" />
      <AlertTitle>No saved profiles yet.</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          Open Generate, configure the dials for a specific demo, and click{" "}
          <strong>Save profile</strong> to keep that configuration around for
          next time.
        </p>
        <Button asChild size="sm" variant="outline" className="bg-background">
          <Link href="/generate">Go to Generate</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function ProfilesSkeleton() {
  return (
    <ul className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <li key={i}>
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/4" />
              </CardTitle>
              <CardDescription className="sr-only">Loading...</CardDescription>
            </CardHeader>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function triggerDownload(content: string, filename: string) {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke until next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
