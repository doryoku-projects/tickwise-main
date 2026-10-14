/*
 * Dependency-free replacement for `twMerge(clsx(...))`.
 *
 * Why this needs to resolve conflicts at all, rather than just concatenating:
 * class order in the `class` attribute does not decide which Tailwind utility
 * wins — the order the utilities were generated into the stylesheet does, and
 * that's Tailwind's internal business. So `<Button className="bg-gradient-primary">`
 * (which must override the `default` variant's `bg-primary`) is only reliable if
 * exactly one `bg-*` class reaches the DOM. That's what this does: group each
 * class by the CSS property it governs, and keep the last one per group.
 *
 * Scope is deliberate. The matcher table below covers the conflict groups this
 * codebase actually exercises, verified against every real call site (see the
 * parity check in scripts/ that diffed this against tailwind-merge's output on
 * those inputs before the dependency was dropped). Anything outside the table
 * falls back to exact-string dedupe, which can never *wrongly* merge two
 * unrelated classes — the failure mode is only that a novel conflicting pair
 * would both survive, which is the same behavior plain concatenation has.
 */

export type ClassValue = string | number | null | undefined | false | ClassValue[];

/** Tailwind font-size scale — distinguishes `text-sm` (size) from `text-primary` (color). */
const FONT_SIZES = new Set([
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "8xl",
  "9xl",
]);

/** Values that make `border-*` a width/side rather than a color. */
const BORDER_NON_COLOR = new Set(["0", "2", "4", "8", "t", "r", "b", "l", "x", "y", "s", "e"]);

const PADDING_PREFIXES = ["px", "py", "pt", "pr", "pb", "pl", "ps", "pe", "p"];
const MARGIN_PREFIXES = ["mx", "my", "mt", "mr", "mb", "ml", "ms", "me", "m"];

/** Returns the conflict-group id for a bare utility (no variant modifiers), or null. */
function utilityGroup(utility: string): string | null {
  // Strip an opacity modifier (`bg-primary/90` -> `bg-primary`) before analysis.
  const base = utility.split("/")[0];

  if (base === "bg" || base.startsWith("bg-")) return "bg";

  if (base === "text" || base.startsWith("text-")) {
    const rest = base.slice(5);
    // Arbitrary values like text-[13px] are sizes; named scale values too.
    if (FONT_SIZES.has(rest) || /^\[/.test(rest)) return "text-size";
    return "text-color";
  }

  if (base === "border" || base.startsWith("border-")) {
    if (base === "border") return "border-width";
    const rest = base.slice(7).split("-")[0];
    return BORDER_NON_COLOR.has(rest) ? "border-width" : "border-color";
  }

  // `ring-1` is a width, `ring-ring` is a colour — the button base uses both
  // together (`focus-visible:ring-1 focus-visible:ring-ring`), so collapsing
  // them into one group would silently delete the ring width.
  if (base === "ring") return "ring-width";
  if (base.startsWith("ring-")) {
    const rest = base.slice(5);
    return /^\d+$/.test(rest) || rest === "inset" ? "ring-width" : "ring-color";
  }

  // Flexbox alignment: `justify-start` must displace the base's `justify-center`.
  for (const p of ["justify", "items", "self", "content", "place"]) {
    if (base.startsWith(`${p}-`)) return p;
  }

  for (const p of ["h", "w", "gap", "rounded", "shadow", "opacity", "outline", "leading"]) {
    if (base === p || base.startsWith(`${p}-`)) return p;
  }

  // `transition`, `transition-colors`, `transition-transform` all conflict.
  if (base === "transition" || base.startsWith("transition-")) return "transition";
  if (base === "duration" || base.startsWith("duration-")) return "duration";

  // Longest prefix first so `px-` isn't shadowed by `p-`.
  for (const p of PADDING_PREFIXES) if (base.startsWith(`${p}-`)) return p;
  for (const p of MARGIN_PREFIXES) if (base.startsWith(`${p}-`)) return p;

  return null;
}

/**
 * Splits a class into its variant modifiers and bare utility, ignoring `:`
 * inside `[]`/`()` so arbitrary values like `data-[state=open]:x` and
 * `hover:scale-[1.02]` are handled correctly.
 */
function splitModifiers(token: string): { modifiers: string; utility: string } {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) lastColon = i;
  }
  return lastColon === -1
    ? { modifiers: "", utility: token }
    : { modifiers: token.slice(0, lastColon + 1), utility: token.slice(lastColon + 1) };
}

/**
 * A class only conflicts with another under the *same* variant modifiers —
 * `hover:bg-x` must not displace a plain `bg-y`. Unknown utilities key on their
 * full text so they only ever dedupe against an identical copy.
 */
function conflictKey(token: string): { key: string; modifiers: string; group: string | null } {
  const { modifiers, utility } = splitModifiers(token);
  // `!` important prefix participates in the key so `!bg-x` and `bg-y` coexist,
  // matching tailwind-merge.
  const bang = utility.startsWith("!") ? "!" : "";
  const group = utilityGroup(bang ? utility.slice(1) : utility);
  return {
    key: group ? `${modifiers}${bang}${group}` : `${modifiers}${utility}`,
    modifiers: `${modifiers}${bang}`,
    group,
  };
}

/*
 * Groups a class also displaces, beyond its own. Tailwind's font-size utilities
 * set line-height as well as size, so a later `text-sm` must remove an earlier
 * `leading-none` — otherwise the leading survives and the text renders at a
 * different line-height than it does today. This mirrors tailwind-merge's
 * `conflictingClassGroups`.
 */
const ALSO_DISPLACES: Record<string, string[]> = {
  "text-size": ["leading"],
};

function flatten(inputs: ClassValue[], out: string[]): void {
  for (const input of inputs) {
    if (!input) continue;
    if (Array.isArray(input)) flatten(input, out);
    else out.push(String(input));
  }
}

/** Joins class values, keeping only the last class per conflict group. */
export function cn(...inputs: ClassValue[]): string {
  const raw: string[] = [];
  flatten(inputs, raw);

  const tokens = raw.flatMap((s) => s.split(/\s+/)).filter(Boolean);
  // Map preserves insertion order; re-setting an existing key keeps that
  // original position, so we delete first to move the winner to the end. This
  // matches tailwind-merge, which emits the surviving class at its own position.
  const byKey = new Map<string, string>();
  for (const token of tokens) {
    const { key, modifiers, group } = conflictKey(token);
    if (byKey.has(key)) byKey.delete(key);
    byKey.set(key, token);
    // Drop any group this class also governs (e.g. text-sm removes leading-*).
    for (const displaced of (group && ALSO_DISPLACES[group]) || []) {
      byKey.delete(`${modifiers}${displaced}`);
    }
  }
  return Array.from(byKey.values()).join(" ");
}
