import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }) {
  const v = {
    default: 'bg-panel border border-line hover:bg-sunken text-ink',
    primary: 'bg-accent text-accent-ink hover:opacity-90 border border-transparent',
    ghost: 'hover:bg-sunken text-muted hover:text-ink border border-transparent',
    danger: 'bg-panel border border-line text-danger hover:bg-sunken',
  }[variant];
  const s = size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm';
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:opacity-50 ${v} ${s} ${className}`}
      {...p}
    />
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = '', ...p }, ref) {
  return (
    <input
      ref={ref}
      className={`h-9 w-full rounded-md border border-line bg-panel px-3 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none ${className}`}
      {...p}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className = '', ...p },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={`w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none ${className}`}
      {...p}
    />
  );
});

export function Select({ className = '', ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-9 rounded-md border border-line bg-panel px-2 text-sm text-ink focus:border-accent focus:outline-none ${className}`}
      {...p}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-line bg-sunken px-1 font-mono text-[11px] text-muted">
      {children}
    </kbd>
  );
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'accent' | 'warn' | 'danger' }) {
  const t = {
    default: 'bg-sunken text-muted',
    accent: 'bg-accent-soft text-accent',
    warn: 'bg-sunken text-warn',
    danger: 'bg-sunken text-danger',
  }[tone];
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${t}`}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-muted">{children}</div>;
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-wide text-faint uppercase">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Comma-separated tag editor. */
export function TagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  return (
    <Input
      defaultValue={value.join(', ')}
      key={value.join(',')}
      placeholder="tags, comma separated"
      onBlur={(e) => {
        const next = e.target.value.split(',').map((t) => t.trim()).filter(Boolean);
        if (next.join(',') !== value.join(',')) onChange(next);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
