import type { ComponentProps } from 'preact';
import { forwardRef } from 'preact/compat';

interface FieldProps extends ComponentProps<'label'> {
  label: string;
  sublabel?: string;
}

export function Field({ label, sublabel, children, class: className, ...props }: FieldProps) {
  return (
    <label class={`field ${className || ''}`.trim()} {...props}>
      <span>
        {label}
        {sublabel ? <span class="muted"> {sublabel}</span> : null}
      </span>
      {children}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'>>((props, ref) => {
  return <input ref={ref} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'>>((props, ref) => {
  return <textarea ref={ref} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, ComponentProps<'select'>>((props, ref) => {
  return <select ref={ref} {...props} />;
});
