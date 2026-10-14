"use client";

import { Check, Terminal } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/clipboard";

/**
 * "Copy this view as a /v1 call": puts a `curl` for the same list, through the
 * paid API, on the clipboard. The dashboards read the keyless `/api`, which is
 * budgeted per address for the site's own use; someone who wants this data in a
 * script is pointed at `/v1` and a free key, in the place they are already
 * looking at the data.
 *
 * `getCommand` is called at click time, so the copy always describes the view as
 * it is now (a filter changed a moment ago is in it).
 */
export function CopyV1CallButton({ getCommand }: { getCommand: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  // In a ref and cleared on unmount, so a quick second click cannot have the
  // first click's timer reset it and nothing fires after teardown.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    setState((await copyToClipboard(getCommand())) ? "copied" : "failed");
    timer.current = setTimeout(() => setState("idle"), 6000);
  };

  return (
    <>
      <button
        type="button"
        className="iconButton"
        onClick={() => void copy()}
        title="Copy this view as a /v1 API call"
        aria-label="Copy this view as a /v1 API call"
      >
        {state === "copied" ? <Check size={16} /> : <Terminal size={16} />}
      </button>
      {/* aria-live so the result is announced; the node is always mounted for that. */}
      <span className="v1CopyHint" role="status" aria-live="polite">
        {state === "copied" ? (
          <>
            Copied. Replace YOUR_API_KEY, <Link href="/portal">get a free key</Link>
          </>
        ) : state === "failed" ? (
          "Copy failed"
        ) : null}
      </span>
    </>
  );
}
