'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';

/**
 * Light/dark toggle for the marketing and portal chrome.
 *
 * The Tickwise design source keeps theme selection in /portal/settings only,
 * but this app has always offered the switch from the public header (the
 * `LIGHT`/`DARK` control in the legacy AppNav), and dropping a working control
 * during a re-skin is a regression rather than a design decision. So it stays —
 * restyled as an icon button in the header's own language rather than the old
 * labelled pill.
 *
 * Renders a fixed-size placeholder until mounted: `useTheme` only knows the
 * real value after the provider's effect has read localStorage, and swapping
 * the glyph on hydration would flash the wrong icon.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-label={mounted ? `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme` : 'Switch theme'}
      className={`h-8 w-8 shrink-0 px-0 text-muted-foreground hover:text-foreground ${className}`}
    >
      {mounted && theme === 'light' ? (
        <Moon className="h-4 w-4" />
      ) : (
        <Sun className="h-4 w-4" />
      )}
    </Button>
  );
}
