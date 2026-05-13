"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { LANGUAGES } from "@/lib/utils/language-geography";
import { Plus, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  /** Codes already in the distribution — disabled in the picker. */
  alreadyAdded: string[];
  onAdd: (code: string) => void;
  disabled?: boolean;
}

export function AddLanguagePopover({ alreadyAdded, onAdd, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const added = new Set(alreadyAdded.map((c) => c.toLowerCase()));
  const remaining = LANGUAGES.length - added.size;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || remaining === 0}
          aria-label="Add a language"
        >
          <Plus className="h-3.5 w-3.5" />
          {remaining === 0 ? "All languages added" : "Add language"}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[320px] p-0"
        // Wider than the default popover so native names + flags fit cleanly.
      >
        <Command
          filter={(value, search) => {
            // `value` is the language code; we search across name + nativeName + code.
            const lang = LANGUAGES.find((l) => l.code === value);
            if (!lang) return 0;
            const haystack =
              `${lang.name} ${lang.nativeName} ${lang.code}`.toLowerCase();
            return haystack.includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder="Search languages..." autoFocus />
          <CommandList>
            <CommandEmpty>No languages match.</CommandEmpty>
            <CommandGroup>
              {LANGUAGES.map((lang) => {
                const isAdded = added.has(lang.code);
                return (
                  <CommandItem
                    key={lang.code}
                    value={lang.code}
                    disabled={isAdded}
                    onSelect={(value) => {
                      if (added.has(value)) return;
                      onAdd(value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex items-center justify-between gap-2",
                      isAdded && "opacity-60",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className="text-base">
                        {lang.flag}
                      </span>
                      <span className="min-w-0">
                        <div className="text-sm font-medium leading-tight">
                          {lang.nativeName}
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            {lang.name}
                          </span>
                        </div>
                        <div className="font-mono text-[10px] uppercase text-muted-foreground">
                          {lang.code}
                          {lang.notes && (
                            <span
                              className="ml-1.5 normal-case"
                              title={lang.notes}
                            >
                              · note
                            </span>
                          )}
                        </div>
                      </span>
                    </span>
                    {isAdded ? (
                      <span className="text-[10px] font-medium text-muted-foreground">
                        Added
                      </span>
                    ) : (
                      <Check className="h-3.5 w-3.5 opacity-0" aria-hidden />
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
