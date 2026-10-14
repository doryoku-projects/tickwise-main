"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Replacement for @radix-ui/react-slot, which Button used only for its `asChild`
 * prop. `asChild` renders the button's styling onto its single child instead of
 * emitting a <button> — roughly half of Button's call sites use it to make a
 * next/link <Link> look like a button, e.g.
 *
 *   <Button asChild size="lg"><Link href="/signup">Get an API key</Link></Button>
 *
 * so the child must receive the merged className while staying an <a>.
 */

function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref && typeof ref === "object") {
        (ref as React.MutableRefObject<T | null>).current = node;
      }
    }
  };
}

type AnyProps = Record<string, unknown>;

function mergeProps(childProps: AnyProps, slotProps: AnyProps): AnyProps {
  const merged: AnyProps = { ...childProps };

  for (const key of Object.keys(slotProps)) {
    const childValue = childProps[key];
    const slotValue = slotProps[key];

    if (
      /^on[A-Z]/.test(key) &&
      typeof childValue === "function" &&
      typeof slotValue === "function"
    ) {
      // Both handlers run, child's first — matching Radix, so a child's own
      // onClick isn't silently swallowed by the one Button passes down.
      merged[key] = (...args: unknown[]) => {
        (childValue as (...a: unknown[]) => unknown)(...args);
        (slotValue as (...a: unknown[]) => unknown)(...args);
      };
    } else if (key === "style") {
      merged[key] = { ...(childValue as object), ...(slotValue as object) };
    } else if (key === "className") {
      merged[key] = cn(childValue as string, slotValue as string);
    } else {
      merged[key] = slotValue;
    }
  }

  return merged;
}

/**
 * Renders its single child element with the Slot's own props merged in. Anything
 * other than a single element renders nothing, matching Radix's behaviour rather
 * than throwing at runtime.
 */
export const Slot = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(function Slot(
  { children, ...slotProps },
  forwardedRef,
) {
  if (!React.isValidElement(children)) return null;

  const child = children as React.ReactElement<AnyProps>;
  // React 19 exposes ref as a regular prop; the legacy `.ref` access is kept
  // as a fallback so a child holding its own ref still receives the node.
  const childRef =
    (child.props as { ref?: React.Ref<HTMLElement> }).ref ??
    (child as unknown as { ref?: React.Ref<HTMLElement> }).ref;

  return React.cloneElement(child, {
    ...mergeProps(child.props, slotProps as AnyProps),
    ref: composeRefs(forwardedRef, childRef),
  } as AnyProps);
});
