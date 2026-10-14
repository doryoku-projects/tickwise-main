/*
 * Toast store — replaces the `sonner` package.
 *
 * Deliberately a module-level singleton rather than a hook: call sites do
 * `import { toast } from "..."` and then `toast.success(msg)` inside plain event
 * handlers, so `toast` has to work outside of React's render tree. The mounted
 * <Toaster> subscribes to this store. (sonner is built the same way.)
 *
 * Only `success` and `error` exist because those are the only variants the app
 * uses — no promise/action/custom toasts anywhere. Keeping the API to what's
 * actually needed means the four call sites change nothing but their import.
 */

export type ToastVariant = "success" | "error";

export type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
  /** True once dismissal starts, so the exit animation can play before removal. */
  closing: boolean;
};

type Listener = (items: readonly ToastItem[]) => void;

/** Matches sonner's default visible duration. */
const DURATION_MS = 4000;
/** Must stay in step with the exit transition in toast.css. */
const EXIT_MS = 200;

let items: readonly ToastItem[] = [];
let nextId = 0;
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Stable empty array so useSyncExternalStore's server snapshot is referentially stable. */
export const EMPTY_TOASTS: readonly ToastItem[] = [];

function emit(): void {
  for (const listener of listeners) listener(items);
}

function remove(id: number): void {
  items = items.filter((t) => t.id !== id);
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  emit();
}

/** Starts the exit animation, then removes the toast once it has played. */
export function dismissToast(id: number): void {
  const target = items.find((t) => t.id === id);
  if (!target || target.closing) return;
  items = items.map((t) => (t.id === id ? { ...t, closing: true } : t));
  emit();
  timers.set(
    id,
    setTimeout(() => remove(id), EXIT_MS),
  );
}

function show(variant: ToastVariant, message: string): number {
  const id = ++nextId;
  items = [...items, { id, message, variant, closing: false }];
  emit();
  timers.set(
    id,
    setTimeout(() => dismissToast(id), DURATION_MS),
  );
  return id;
}

export const toast = {
  success: (message: string) => show("success", message),
  error: (message: string) => show("error", message),
};

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): readonly ToastItem[] {
  return items;
}
