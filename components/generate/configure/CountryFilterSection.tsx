"use client";

import { useMemo, useState } from "react";
import { useGenerationStore } from "@/store/generation-store";
import { WORLD_COUNTRIES, countryFlagEmoji } from "@/lib/utils/world-countries";
import type { CountryFilterEntry } from "@/lib/profiles/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Globe, Plus, X } from "lucide-react";

// ---------------------------------------------------------------------------
// Section root
// ---------------------------------------------------------------------------

export function CountryFilterSection() {
  const countryFilter: CountryFilterEntry[] = useGenerationStore(
    (s) => s.draft.countryFilter ?? [],
  );
  const setDraft = useGenerationStore((s) => s.setDraft);
  const [pickerOpen, setPickerOpen] = useState(false);

  const selectedCodes = useMemo(
    () => new Set(countryFilter.map((e) => e.code)),
    [countryFilter],
  );

  function addCountry(code: string, name: string) {
    setDraft((d) => {
      d.countryFilter = [...(d.countryFilter ?? []), { code, name, weight: 100 }];
    });
    setPickerOpen(false);
  }

  function removeCountry(code: string) {
    setDraft((d) => {
      d.countryFilter = (d.countryFilter ?? []).filter((e) => e.code !== code);
    });
  }

  function updateWeight(code: string, weight: number) {
    setDraft((d) => {
      d.countryFilter = (d.countryFilter ?? []).map((e) =>
        e.code === code ? { ...e, weight } : e,
      );
    });
  }

  function clearAll() {
    setDraft((d) => {
      d.countryFilter = [];
    });
  }

  const totalWeight = countryFilter.reduce((s, e) => s + e.weight, 0);

  return (
    <section id="countries" className="scroll-mt-24">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4" />
            Country filter
          </CardTitle>
          <CardDescription>
            Restrict which countries personas are assigned to. Useful when demoing to a
            region-specific customer. Leave empty to let the language distribution pick
            countries automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {countryFilter.length === 0 ? (
            /* Empty state */
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-7 text-center">
              <p className="text-sm text-muted-foreground">
                No filter — countries follow the language distribution above.
              </p>
              <CountryPicker
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                selectedCodes={selectedCodes}
                onSelect={addCountry}
              />
            </div>
          ) : (
            /* Populated state */
            <div className="space-y-3">
              {countryFilter.map((entry) => (
                <CountryRow
                  key={entry.code}
                  entry={entry}
                  pct={totalWeight > 0 ? Math.round((entry.weight / totalWeight) * 100) : 0}
                  onWeightChange={(w) => updateWeight(entry.code, w)}
                  onRemove={() => removeCountry(entry.code)}
                />
              ))}

              <div className="flex items-center justify-between pt-1">
                <CountryPicker
                  open={pickerOpen}
                  onOpenChange={setPickerOpen}
                  selectedCodes={selectedCodes}
                  onSelect={addCountry}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={clearAll}
                >
                  Clear all
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Country row (flag + name + weight slider + remove)
// ---------------------------------------------------------------------------

function CountryRow({
  entry,
  pct,
  onWeightChange,
  onRemove,
}: {
  entry: CountryFilterEntry;
  pct: number;
  onWeightChange: (w: number) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {/* Flag */}
      <span className="shrink-0 text-lg leading-none" aria-hidden>
        {countryFlagEmoji(entry.code)}
      </span>

      {/* Name + slider */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
            {pct}%
          </span>
        </div>
        <Slider
          min={1}
          max={100}
          step={1}
          value={[entry.weight]}
          onValueChange={([v]) => onWeightChange(v ?? entry.weight)}
          className="h-4"
          aria-label={`Weight for ${entry.name}`}
        />
      </div>

      {/* Remove */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        aria-label={`Remove ${entry.name}`}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Country picker popover (Command-based search, grouped by region)
// ---------------------------------------------------------------------------

function CountryPicker({
  open,
  onOpenChange,
  selectedCodes,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  selectedCodes: Set<string>;
  onSelect: (code: string, name: string) => void;
}) {
  // Group countries by region — computed once per render (WORLD_COUNTRIES is static).
  const grouped = useMemo(() => {
    const map = new Map<string, typeof WORLD_COUNTRIES>();
    for (const c of WORLD_COUNTRIES) {
      if (!map.has(c.region)) map.set(c.region, []);
      map.get(c.region)!.push(c);
    }
    return [...map.entries()];
  }, []);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          Add country
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search countries…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No countries found.</CommandEmpty>
            {grouped.map(([region, countries]) => {
              const available = countries.filter((c) => !selectedCodes.has(c.code));
              if (available.length === 0) return null;
              return (
                <CommandGroup key={region} heading={region}>
                  {available.map((c) => (
                    <CommandItem
                      key={c.code}
                      value={`${c.name} ${c.code}`}
                      onSelect={() => onSelect(c.code, c.name)}
                      className="gap-2"
                    >
                      <span aria-hidden>{countryFlagEmoji(c.code)}</span>
                      <span className="flex-1">{c.name}</span>
                      <span className="text-xs text-muted-foreground">{c.code}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
