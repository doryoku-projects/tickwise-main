"use client";

import * as React from "react";

/**
 * Supports both controlled and uncontrolled usage from one component, the way
 * the Radix primitives did: pass `value` to control it, or omit it and pass
 * `defaultValue` to let the component own the state. `onChange` fires either way.
 */
export function useControllableState<T>(
  controlled: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): readonly [T, (value: T) => void] {
  const [uncontrolled, setUncontrolled] = React.useState<T>(defaultValue);
  const isControlled = controlled !== undefined;
  const value = isControlled ? controlled : uncontrolled;

  const setValue = React.useCallback(
    (next: T) => {
      if (!isControlled) setUncontrolled(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );

  return [value, setValue] as const;
}
