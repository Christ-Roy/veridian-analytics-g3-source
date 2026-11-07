"use client";

import { Search } from "lucide-react";
import { useExtracted } from "next-intl";
import { Input } from "@/components/ui/input";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function SearchInput({ value, onChange, placeholder, className = "max-w-sm" }: SearchInputProps) {
  // Même défaut que MultiSelect : une valeur par défaut de paramètre ne peut
  // pas appeler `t()`, donc elle restait en anglais.
  const t = useExtracted();
  const texte = placeholder ?? t("Search...");
  return (
    <div className={`relative ${className}`}>
      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-neutral-500 dark:text-neutral-400" />
      <Input
        placeholder={texte}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="pl-9 bg-neutral-50 dark:bg-neutral-900 border-neutral-100 dark:border-neutral-800"
      />
    </div>
  );
}
