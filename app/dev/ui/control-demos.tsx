"use client";

import * as React from "react";
import { formatINR, withTax } from "@/lib/money";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QuantityStepper } from "@/components/ui/quantity-stepper";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Demo, DemoGrid } from "@/app/dev/ui/section";

const STATES = ["Delhi", "Gujarat", "Karnataka", "Maharashtra", "Tamil Nadu", "Telangana", "Uttar Pradesh", "West Bengal"];
const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "12 months" },
] as const;
type Range = (typeof RANGES)[number]["value"];

/** Text inputs, selects and choice controls in their states. */
export function ControlDemos() {
  const [priceMode, setPriceMode] = React.useState<"excl" | "incl">("excl");
  const [range, setRange] = React.useState<Range>("30");
  const [terminals, setTerminals] = React.useState(1);
  const [twoStep, setTwoStep] = React.useState(true);
  const [agree, setAgree] = React.useState(false);
  const annual = 299_900;
  const shown = priceMode === "incl" ? withTax(annual) : annual;

  return (
    <DemoGrid>
      <Demo title="Input states">
        <Field label="Business name">
          <Input placeholder="e.g. Sharma Medical Store" />
        </Field>
        <Field label="Email" hint="Focus ring simulated below.">
          <Input type="email" defaultValue="priya@example.com" className="border-primary shadow-focus" />
        </Field>
        <Field label="GSTIN" optional>
          <Input mono className="uppercase" placeholder="27ABCDE1234F1Z5" />
        </Field>
        <Field label="Mobile" error="Enter a 10-digit Indian mobile number.">
          <Input inputMode="numeric" defaultValue="12345" />
        </Field>
        <Field label="Disabled">
          <Input disabled defaultValue="Read only for your role" />
        </Field>
        <Field label="Admin input (sm)" size="sm">
          <Input size="sm" placeholder="Search order ID" />
        </Field>
        <Field label="Search (lg)">
          <Input size="lg" type="search" placeholder="Search software" />
        </Field>
      </Demo>

      <Demo title="Textarea and selects">
        <Field label="Describe the problem" hint="Include the error message if there is one.">
          <Textarea placeholder="What happened?" />
        </Field>
        <Field label="State / UT">
          <NativeSelect placeholder="Select state">
            {STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="State (invalid)" error="Select your state.">
          <NativeSelect placeholder="Select state">
            {STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Sort by">
          {(control) => (
            // Radix Select's root renders no element, so the ids go on the trigger (render-prop form of Field).
            <Select defaultValue="popular">
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="popular">Most popular</SelectItem>
                <SelectItem value="price-asc">Price: low to high</SelectItem>
                <SelectItem value="price-desc">Price: high to low</SelectItem>
                <SelectItem value="newest">Newest</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
      </Demo>

      <Demo title="Segmented controls">
        <div className="grid gap-2">
          <SegmentedControl
            aria-label="Price display"
            value={priceMode}
            onValueChange={setPriceMode}
            options={[
              { value: "excl", label: "Excl. GST" },
              { value: "incl", label: "Incl. 18% GST" },
            ]}
          />
          <p className="text-[14px] text-ink-2">
            From <span className="text-[22px] font-extrabold text-ink">{formatINR(shown)}</span> /year
            {priceMode === "excl" ? " + GST" : " incl. GST"}
          </p>
        </div>
        <SegmentedControl
          aria-label="Date range"
          variant="chip"
          value={range}
          onValueChange={setRange}
          options={RANGES}
        />
      </Demo>

      <Demo title="Quantity stepper">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span id="terminals-label" className="text-[14px] font-bold">
            Terminals
          </span>
          <QuantityStepper
            aria-labelledby="terminals-label"
            value={terminals}
            onValueChange={setTerminals}
            min={1}
            max={10}
            decrementLabel="Fewer terminals"
            incrementLabel="More terminals"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[14px] font-bold">Cart line (sm, disabled)</span>
          <QuantityStepper label="Quantity" size="sm" value={2} onValueChange={() => undefined} disabled />
        </div>
      </Demo>

      <Demo title="Checkbox, radio, switch">
        <div className="flex items-start gap-2.5">
          <Checkbox id="demo-agree" checked={agree} onCheckedChange={(value) => setAgree(value === true)} />
          <Label htmlFor="demo-agree" className="font-semibold">
            I agree to the Terms and Refund policy.
          </Label>
        </div>
        <div className="flex items-start gap-2.5">
          <Checkbox id="demo-indeterminate" checked="indeterminate" />
          <Label htmlFor="demo-indeterminate" className="font-semibold">
            Select all on this page (indeterminate)
          </Label>
        </div>
        <div className="flex items-start gap-2.5">
          <Checkbox id="demo-disabled" disabled defaultChecked />
          <Label htmlFor="demo-disabled" className="font-semibold">
            Disabled
          </Label>
        </div>
        <RadioGroup aria-label="Starting price" defaultValue="any">
          {[
            ["any", "Any price"],
            ["under-3000", "Under ₹3,000"],
            ["3000-6000", "₹3,000 – ₹6,000"],
          ].map(([value, text]) => (
            <div key={value} className="flex items-center gap-2.5">
              <RadioGroupItem id={`price-${value}`} value={value ?? ""} />
              <Label htmlFor={`price-${value}`} className="font-semibold">
                {text}
              </Label>
            </div>
          ))}
        </RadioGroup>
        <div className="flex items-center justify-between gap-3">
          <Label id="two-step-label" htmlFor="two-step">
            Two-step sign-in
          </Label>
          <Switch id="two-step" checked={twoStep} onCheckedChange={setTwoStep} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="switch-disabled">Disabled switch</Label>
          <Switch id="switch-disabled" disabled />
        </div>
      </Demo>
    </DemoGrid>
  );
}
