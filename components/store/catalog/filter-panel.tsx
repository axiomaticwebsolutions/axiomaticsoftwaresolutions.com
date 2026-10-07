"use client";

import { useId, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  isPriceBandKey,
  type CatalogFacets,
  type CatalogListFacet,
  type FacetOption,
  type PriceBandKey,
} from "@/lib/storefront/catalog-filter";

export type FilterPanelProps = {
  facets: CatalogFacets;
  onToggle: (facet: CatalogListFacet, value: string) => void;
  onPrice: (band: PriceBandKey) => void;
  /** "Clear all filters" (also clears the search, as in the prototype). */
  onClear: () => void;
};

function OptionRow({ control, option }: { control: ReactNode; option: FacetOption<string> }) {
  return (
    <label className="-mx-2 flex cursor-pointer items-center gap-2.5 rounded-10 px-2 py-[7px] text-[15px] font-semibold transition-colors hover:bg-lavender-soft">
      {control}
      <span className="flex-1">{option.label}</span>
      {option.count !== null ? (
        <>
          <span aria-hidden="true" className="text-[13px] text-ink-3 tabular">
            {option.count}
          </span>
          <span className="sr-only">
            , {option.count} {option.count === 1 ? "product" : "products"}
          </span>
        </>
      ) : null}
    </label>
  );
}

function Group({ legend, legendId, children }: { legend: string; legendId: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 min-w-0 border-b border-line px-0 py-[18px]">
      <legend id={legendId} className="mb-3 p-0 text-[13px] font-extrabold uppercase tracking-[0.08em] text-ink-2">
        {legend}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * The catalog filters (sidebar >= 900px, drawer below): Business category, Starting price, Operating system and
 * License type, each option with its live count, then "Clear all filters".
 */
export function FilterPanel({ facets, onToggle, onPrice, onClear }: FilterPanelProps) {
  const id = useId();
  const listGroup = (facet: CatalogListFacet, legend: string) => (
    <Group key={facet} legend={legend} legendId={`${id}-${facet}`}>
      <div className="grid gap-1">
        {facets[facet].map((option) => (
          <OptionRow
            key={option.value}
            option={option}
            control={<Checkbox checked={option.checked} onCheckedChange={() => onToggle(facet, option.value)} />}
          />
        ))}
      </div>
    </Group>
  );
  const selectedBand = facets.price.find((o) => o.checked)?.value ?? "any";

  return (
    <>
      {listGroup("category", "Business category")}
      <Group legend="Starting price" legendId={`${id}-price`}>
        <RadioGroup
          value={selectedBand}
          onValueChange={(value) => {
            if (isPriceBandKey(value)) onPrice(value);
          }}
          aria-labelledby={`${id}-price`}
          className="gap-1"
        >
          {facets.price.map((option) => (
            <OptionRow key={option.value} option={option} control={<RadioGroupItem value={option.value} />} />
          ))}
        </RadioGroup>
      </Group>
      {listGroup("os", "Operating system")}
      {listGroup("license", "License type")}
      <button
        type="button"
        onClick={onClear}
        className="mt-4 cursor-pointer rounded-6 border-0 bg-transparent p-0 text-[14.5px] font-bold text-primary-link transition-colors hover:text-primary-link-hover"
      >
        Clear all filters
      </button>
    </>
  );
}
