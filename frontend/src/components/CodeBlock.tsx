"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A copy-pasteable code block: language label, copy button, mono body.
 *
 * `lang` is a LABEL only — nothing here highlights syntax, so it can be any
 * string that tells the reader what they are looking at.
 *
 * The copy path is deliberately defensive, matching `PayInstructions` and
 * `KeyReveal` rather than the optimistic version this shipped with:
 * `navigator.clipboard` is `undefined` on any non-secure origin except
 * localhost, so an unguarded `writeText` throws a TypeError, the promise is
 * never handled, and the button silently does nothing. On failure we surface
 * "select it" instead, because a copy button that appears to work and doesn't
 * is worse than one that admits it can't.
 */
export function CodeBlock({ code, lang = "bash" }: { code: string; lang?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  // Held in a ref and cleared on unmount so rapid clicks can't have an earlier
  // timer reset a later click's state, and so nothing fires after teardown.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 1600);
  }, [code]);

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border/60 bg-[color:var(--surface-2)]">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5 text-[0.6875rem] uppercase tracking-widest text-muted-foreground">
        <span className="font-mono">{lang}</span>
        <Button
          // `Button` sets no default type, so inside a form this would submit it.
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-xs"
          onClick={copy}
        >
          {state === "copied" ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {state === "copied" ? "copied" : state === "failed" ? "select it" : "copy"}
        </Button>
      </div>
      {/*
        tabIndex makes a long line scrollable without a mouse (WCAG 2.1.1); the
        legacy `.docsCode` it replaces was not keyboard-scrollable either.
        aria-live announces the copy result, which a changing button label does
        not do reliably across screen readers.
      */}
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed" tabIndex={0}>
        <code>{code}</code>
      </pre>
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed — select the text manually" : ""}
      </span>
    </div>
  );
}
