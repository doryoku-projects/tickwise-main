'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';

/**
 * A password input with a reveal toggle. One implementation for every password
 * field in the product (sign in, sign up + confirm, change password), so the
 * control behaves and reads the same everywhere.
 *
 * Two things are load-bearing and easy to get wrong:
 *  - the toggle is a `type="button"`, so it can never submit the form it sits
 *    inside — an eye icon that posts the login form is a bug people hit once
 *    and never forgive;
 *  - `name` and `autoComplete` stay on the input and the element is never
 *    remounted (only its `type` flips), which is what keeps browser and
 *    password-manager autofill working.
 */
export function PasswordField({
  value,
  onChange,
  placeholder,
  autoComplete,
  name,
  id,
  disabled,
  required,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 'current-password' on sign-in, 'new-password' everywhere else. */
  autoComplete: 'current-password' | 'new-password';
  name?: string;
  id?: string;
  disabled?: boolean;
  required?: boolean;
  /** Only needed when the placeholder isn't the whole story. */
  ariaLabel?: string;
}) {
  const [shown, setShown] = useState(false);
  const action = shown ? 'Hide password' : 'Show password';

  return (
    <div className="pwField">
      <input
        className="admin-input"
        type={shown ? 'text' : 'password'}
        autoComplete={autoComplete}
        name={name}
        id={id}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        disabled={disabled}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="pwToggle"
        onClick={() => setShown((v) => !v)}
        aria-label={action}
        aria-pressed={shown}
        title={action}
        disabled={disabled}
      >
        {shown ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
      </button>
    </div>
  );
}
