import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

/** Campos de formulario accesibles (label + control + ayuda) con las clases del sistema (.label / .input). */

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className = "",
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function TextInput({
  label,
  hint,
  className = "",
  id,
  name,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; name: string }) {
  const fid = id ?? name;
  return (
    <Field label={label} htmlFor={fid} hint={hint} className={className}>
      <input id={fid} name={name} className="input" {...rest} />
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  className = "",
  id,
  name,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: ReactNode;
  hint?: ReactNode;
  name: string;
}) {
  const fid = id ?? name;
  return (
    <Field label={label} htmlFor={fid} hint={hint} className={className}>
      <textarea id={fid} name={name} className="input min-h-20" {...rest} />
    </Field>
  );
}

export function Select({
  label,
  hint,
  className = "",
  id,
  name,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: ReactNode;
  hint?: ReactNode;
  name: string;
  children: ReactNode;
}) {
  const fid = id ?? name;
  return (
    <Field label={label} htmlFor={fid} hint={hint} className={className}>
      <select id={fid} name={name} className="input" {...rest}>
        {children}
      </select>
    </Field>
  );
}

export function Checkbox({
  label,
  hint,
  id,
  name,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; name: string }) {
  const fid = id ?? name;
  return (
    <label htmlFor={fid} className="flex cursor-pointer items-start gap-2.5 py-1 text-sm">
      <input
        id={fid}
        name={name}
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--teal)]"
        {...rest}
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** Input de dinero en pesos (el servidor lo convierte a centavos). */
export function MoneyInput({
  label,
  hint,
  name,
  id,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; name: string }) {
  const fid = id ?? name;
  return (
    <Field label={label} htmlFor={fid} hint={hint} className={className}>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
          $
        </span>
        <input
          id={fid}
          name={name}
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          className="input pl-7"
          {...rest}
        />
      </div>
    </Field>
  );
}

export function FormGrid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const c = { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4" }[cols];
  return <div className={`grid grid-cols-1 gap-3 ${c}`}>{children}</div>;
}
