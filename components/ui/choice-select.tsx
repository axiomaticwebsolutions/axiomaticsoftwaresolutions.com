"use client";

import type * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, type SelectTriggerProps } from "@/components/ui/select";

export type ChoiceOption = { value: string; label: React.ReactNode; disabled?: boolean };

export type ChoiceSelectProps = Omit<SelectTriggerProps, "value" | "defaultValue" | "onChange" | "children" | "dir"> & {
  /** The chosen option's value; "" means nothing chosen yet (the placeholder shows). */
  value: string;
  onValueChange: (value: string) => void;
  options: readonly ChoiceOption[];
  /** Shown while nothing is chosen. */
  placeholder?: string;
  /** Submitted with a native form (Radix renders a hidden <select> for it). */
  name?: string;
  required?: boolean;
  contentClassName?: string;
};

/**
 * The site's styled dropdown for short lists (the Radix listbox in components/ui/select.tsx, so the open list matches
 * the UI instead of the browser's own menu). Takes plain options and a string value like NativeSelect, with "" for
 * nothing chosen. Inside a Field use the render-prop form so the label and error ids land on the trigger:
 * `<Field ...>{(control) => <ChoiceSelect {...control} ... />}</Field>`. Long lists (states) stay NativeSelect: the
 * OS picker is faster there, especially on phones.
 */
export function ChoiceSelect({
  value,
  onValueChange,
  options,
  placeholder,
  name,
  required,
  disabled,
  contentClassName,
  ...trigger
}: ChoiceSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange} name={name} required={required} disabled={disabled}>
      <SelectTrigger {...trigger}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
