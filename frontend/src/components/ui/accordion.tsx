"use client";

import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Was @radix-ui/react-accordion, used only as type="single" collapsible.
 *
 * Two decisions worth explaining:
 *
 * - Plain buttons rather than <details>/<summary>. <details> gives expand and
 *   collapse for free, but has no notion of "opening one closes the others", so
 *   a state-managed wrapper is needed regardless — and once state is managed, a
 *   controlled <details open> fights the browser's own toggling.
 *
 * - The open/close height animation uses the CSS grid 0fr -> 1fr transition
 *   rather than measuring scrollHeight. Radix's version depended on a
 *   --radix-accordion-content-height variable it set from a measurement, which
 *   dies with the package; the grid approach needs no measurement at all and
 *   stays correct when the content reflows (font load, resize, longer text).
 *
 * ARIA is wired explicitly (aria-expanded, aria-controls, role="region",
 * aria-labelledby) because we're not getting it from a primitive. aria-controls
 * is only set while open, matching the previous behaviour: the panel is not
 * rendered when collapsed, and referencing a missing id is worse than omitting it.
 */

type AccordionContextValue = {
  openValue: string | null;
  toggle: (value: string) => void;
};
const AccordionContext = React.createContext<AccordionContextValue | null>(null);

type ItemContextValue = { value: string; triggerId: string; contentId: string };
const ItemContext = React.createContext<ItemContextValue | null>(null);

function useAccordion(): AccordionContextValue {
  const ctx = React.useContext(AccordionContext);
  if (!ctx) throw new Error("Accordion parts must be rendered inside <Accordion>");
  return ctx;
}

function useItem(): ItemContextValue {
  const ctx = React.useContext(ItemContext);
  if (!ctx) throw new Error("Accordion parts must be rendered inside <AccordionItem>");
  return ctx;
}

export function Accordion({
  children,
  className,
  defaultValue = null,
}: {
  children: React.ReactNode;
  className?: string;
  /** Accepted for API compatibility; only single/collapsible is implemented. */
  type?: "single";
  collapsible?: boolean;
  defaultValue?: string | null;
}) {
  const [openValue, setOpenValue] = React.useState<string | null>(defaultValue);
  // Re-selecting the open item closes it (collapsible), and opening one closes
  // any other (single).
  const toggle = React.useCallback(
    (value: string) => setOpenValue((current) => (current === value ? null : value)),
    [],
  );

  return (
    <AccordionContext.Provider value={{ openValue, toggle }}>
      <div className={className}>{children}</div>
    </AccordionContext.Provider>
  );
}

export function AccordionItem({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const triggerId = React.useId();
  const contentId = React.useId();
  const { openValue } = useAccordion();

  return (
    <ItemContext.Provider value={{ value, triggerId, contentId }}>
      <div
        data-state={openValue === value ? "open" : "closed"}
        className={cn("border-b", className)}
      >
        {children}
      </div>
    </ItemContext.Provider>
  );
}

export function AccordionTrigger({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { openValue, toggle } = useAccordion();
  const { value, triggerId, contentId } = useItem();
  const isOpen = openValue === value;

  return (
    <h3 className="flex">
      <button
        type="button"
        id={triggerId}
        aria-expanded={isOpen}
        aria-controls={isOpen ? contentId : undefined}
        data-state={isOpen ? "open" : "closed"}
        onClick={() => toggle(value)}
        className={cn(
          "flex flex-1 items-center justify-between py-4 text-sm font-medium cursor-pointer transition-all hover:underline text-left [&[data-state=open]>svg]:rotate-180",
          className,
        )}
      >
        {children}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200" />
      </button>
    </h3>
  );
}

export function AccordionContent({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { openValue } = useAccordion();
  const { value, triggerId, contentId } = useItem();
  const isOpen = openValue === value;

  // Kept out of the DOM while closed, as before, so collapsed answers aren't
  // read out by a screen reader or found by in-page search.
  if (!isOpen) return null;

  return (
    <div
      id={contentId}
      role="region"
      aria-labelledby={triggerId}
      data-state="open"
      className="grid text-sm"
      style={{ gridTemplateRows: "1fr" }}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={cn("pb-4 pt-0", className)}>{children}</div>
      </div>
    </div>
  );
}
