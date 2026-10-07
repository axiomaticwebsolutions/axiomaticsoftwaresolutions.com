"use client";

import Link from "next/link";
import type * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label, OptionalTag } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { CONTACT_COPY, CONTACT_FIELDS, type ContactMode } from "@/content/contact";
import { PHONE_INPUT_MAX } from "@/lib/validation/contact";
import {
  LEAD_COUNTER_BANDS,
  LEAD_COUNTER_LABELS,
  LEAD_MAX,
  LEAD_SLOTS,
  LEAD_SLOT_LABELS,
  LEAD_TOPICS,
  LEAD_TOPIC_LABELS,
  NOT_SURE_PRODUCT,
  type LeadCounterBand,
} from "@/lib/validation/lead";
import { contactFieldId, type ContactFieldKey, type ContactFormValues, type DemoProductOption } from "./contact-form-model";

function oneOf<T extends string>(list: readonly T[], value: string, fallback: T): T {
  return (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Label with the prototype's "Optional" line under it. */
function OptionalLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid gap-0.5">
      <span>{children}</span>
      <OptionalTag>{CONTACT_FIELDS.optional}</OptionalTag>
    </span>
  );
}

// Prototype controls: 48px, radius 12, 15px/600 text.
const CONTROL = "rounded-12 font-semibold";

export type ContactFieldsProps = {
  mode: ContactMode;
  values: ContactFormValues;
  errors: Partial<Record<ContactFieldKey, string>>;
  products: readonly DemoProductOption[];
  dateMin: string;
  dateMax: string;
  onChange: <K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) => void;
};

/** The field grid, the marketing opt-in with the privacy notice, and the hidden honeypot. */
export function ContactFields({ mode, values, errors, products, dateMin, dateMax, onChange }: ContactFieldsProps) {
  const demo = mode === "demo";
  const text = (key: "name" | "businessName" | "email" | "phone" | "message" | "preferredDate") =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(key, event.target.value);

  const nameField = (
    <Field key="name" id={contactFieldId("name")} label={CONTACT_FIELDS.name} error={errors.name} className="leading-[normal]">
      <Input
        name="name"
        autoComplete="name"
        maxLength={LEAD_MAX.name}
        value={values.name}
        onChange={text("name")}
        className={CONTROL}
      />
    </Field>
  );
  const emailField = (
    <Field key="email" id={contactFieldId("email")} label={CONTACT_FIELDS.email} error={errors.email} className="leading-[normal]">
      <Input
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        spellCheck={false}
        value={values.email}
        onChange={text("email")}
        className={CONTROL}
      />
    </Field>
  );

  const fields: React.ReactNode[] = demo
    ? [
        nameField,
        <Field
          key="businessName"
          id={contactFieldId("businessName")}
          label={CONTACT_FIELDS.businessName}
          error={errors.businessName}
          className="leading-[normal]"
        >
          <Input
            name="businessName"
            autoComplete="organization"
            maxLength={LEAD_MAX.businessName}
            value={values.businessName}
            onChange={text("businessName")}
            className={CONTROL}
          />
        </Field>,
        emailField,
        <Field key="phone" id={contactFieldId("phone")} label={CONTACT_FIELDS.phoneDemo} error={errors.phone} className="leading-[normal]">
          <Input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={PHONE_INPUT_MAX}
            placeholder={CONTACT_FIELDS.phoneDemoPlaceholder}
            value={values.phone}
            onChange={text("phone")}
            className={CONTROL}
          />
        </Field>,
        <Field key="product" id={contactFieldId("product")} label={CONTACT_FIELDS.product} error={errors.product} className="leading-[normal]">
          <NativeSelect
            name="product"
            value={values.product}
            onChange={(event) => onChange("product", event.target.value)}
            className={CONTROL}
          >
            <option value="">{CONTACT_FIELDS.productPlaceholder}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value={NOT_SURE_PRODUCT}>{CONTACT_FIELDS.productNotSure}</option>
          </NativeSelect>
        </Field>,
        <Field
          key="counters"
          id={contactFieldId("counters")}
          label={<OptionalLabel>{CONTACT_FIELDS.counters}</OptionalLabel>}
          error={errors.counters}
          className="leading-[normal]"
        >
          <NativeSelect
            name="counters"
            value={values.counters}
            onChange={(event) => onChange("counters", oneOf<"" | LeadCounterBand>(["", ...LEAD_COUNTER_BANDS], event.target.value, ""))}
            className={CONTROL}
          >
            <option value="">{CONTACT_FIELDS.countersPlaceholder}</option>
            {LEAD_COUNTER_BANDS.map((band) => (
              <option key={band} value={band}>
                {LEAD_COUNTER_LABELS[band]}
              </option>
            ))}
          </NativeSelect>
        </Field>,
        <Field
          key="preferredDate"
          id={contactFieldId("preferredDate")}
          label={CONTACT_FIELDS.preferredDate}
          error={errors.preferredDate}
          className="leading-[normal]"
        >
          <Input
            name="preferredDate"
            type="date"
            min={dateMin}
            max={dateMax}
            value={values.preferredDate}
            onChange={text("preferredDate")}
            className={CONTROL}
          />
        </Field>,
        <Field
          key="preferredSlot"
          id={contactFieldId("preferredSlot")}
          label={CONTACT_FIELDS.preferredSlot}
          error={errors.preferredSlot}
          className="leading-[normal]"
        >
          <NativeSelect
            name="preferredSlot"
            value={values.preferredSlot}
            onChange={(event) => onChange("preferredSlot", oneOf(LEAD_SLOTS, event.target.value, "morning"))}
            className={CONTROL}
          >
            {LEAD_SLOTS.map((slot) => (
              <option key={slot} value={slot}>
                {LEAD_SLOT_LABELS[slot]}
              </option>
            ))}
          </NativeSelect>
        </Field>,
        <Field
          key="message"
          id={contactFieldId("message")}
          label={<OptionalLabel>{CONTACT_FIELDS.demoMessage}</OptionalLabel>}
          error={errors.message}
          className="col-span-full leading-[normal]"
        >
          <Textarea
            name="message"
            rows={5}
            maxLength={LEAD_MAX.message}
            placeholder={CONTACT_FIELDS.demoMessagePlaceholder}
            value={values.message}
            onChange={text("message")}
            className="min-h-0 rounded-12 font-semibold leading-[normal]"
          />
        </Field>,
      ]
    : [
        nameField,
        emailField,
        <Field
          key="phone"
          id={contactFieldId("phone")}
          label={<OptionalLabel>{CONTACT_FIELDS.phoneContact}</OptionalLabel>}
          error={errors.phone}
          className="leading-[normal]"
        >
          <Input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={PHONE_INPUT_MAX}
            value={values.phone}
            onChange={text("phone")}
            className={CONTROL}
          />
        </Field>,
        <Field key="topic" id={contactFieldId("topic")} label={CONTACT_FIELDS.topic} error={errors.topic} className="leading-[normal]">
          <NativeSelect
            name="topic"
            value={values.topic}
            onChange={(event) => onChange("topic", oneOf(LEAD_TOPICS, event.target.value, "sales"))}
            className={CONTROL}
          >
            {LEAD_TOPICS.map((topic) => (
              <option key={topic} value={topic}>
                {LEAD_TOPIC_LABELS[topic]}
              </option>
            ))}
          </NativeSelect>
        </Field>,
        <Field
          key="message"
          id={contactFieldId("message")}
          label={CONTACT_FIELDS.contactMessage}
          error={errors.message}
          className="col-span-full leading-[normal]"
        >
          <Textarea
            name="message"
            rows={5}
            maxLength={LEAD_MAX.message}
            placeholder={CONTACT_FIELDS.contactMessagePlaceholder}
            value={values.message}
            onChange={text("message")}
            className="min-h-0 rounded-12 font-semibold leading-[normal]"
          />
        </Field>,
      ];

  return (
    <>
      {/* Fields stretch to the row height (no items-start), so a row with an "Optional" tag shares the extra height
          between label and control as the prototype's label grids do. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-3.5">{fields}</div>

      <div className="grid gap-2">
        <div className="flex items-start gap-2.5">
          <Checkbox
            id="contact-marketing"
            name="marketingOptIn"
            checked={values.marketingOptIn}
            onCheckedChange={(checked) => onChange("marketingOptIn", checked === true)}
            className="mt-px"
          />
          <Label htmlFor="contact-marketing" className="block cursor-pointer text-[14px] font-semibold leading-[1.5]">
            {CONTACT_COPY.marketingOptIn}
          </Label>
        </div>
        <p className="m-0 text-[13.5px] font-semibold leading-[1.5] text-ink-2">
          {CONTACT_COPY.noticeBeforeLink}
          <Link href={CONTACT_COPY.privacyHref} className="text-primary-link underline underline-offset-2 hover:text-primary-link-hover">
            {CONTACT_COPY.noticeLink}
          </Link>
          {CONTACT_COPY.noticeAfterLink}
        </p>
      </div>

      {/* Honeypot: hidden from people and assistive technology; bots that fill every field get a decoy reply. */}
      <div aria-hidden="true" className="sr-only">
        <label htmlFor="contact-website">{CONTACT_COPY.honeypotLabel}</label>
        <input
          id="contact-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          data-1p-ignore=""
          data-lpignore="true"
          value={values.website}
          onChange={(event) => onChange("website", event.target.value)}
        />
      </div>
    </>
  );
}
