import type { ComponentProps } from 'preact';
import { forwardRef } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';

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

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  badge?: string;
  disabled?: boolean;
}

export interface CustomSelectProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  class?: string;
  id?: string;
}

export function CustomSelect<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = 'Chọn một mục…',
  disabled = false,
  class: className,
  id,
}: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelect = (option: SelectOption<T>) => {
    if (option.disabled) return;
    onChange(option.value);
    setIsOpen(false);
  };

  return (
    <div
      ref={containerRef}
      class={`custom-select ${isOpen ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${className || ''}`.trim()}
      id={id}
    >
      <button
        type="button"
        class="custom-select-trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span class="custom-select-value">
          {selectedOption ? (
            <span class="custom-select-label-wrap">
              <strong class="custom-select-title">{selectedOption.label}</strong>
              {selectedOption.description && (
                <span class="custom-select-desc"> — {selectedOption.description}</span>
              )}
            </span>
          ) : (
            <span class="muted">{placeholder}</span>
          )}
        </span>
        <svg
          class="custom-select-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div class="custom-select-menu" role="listbox">
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={isSelected}
                class={`custom-select-option ${isSelected ? 'is-selected' : ''} ${option.disabled ? 'is-disabled' : ''}`}
                onClick={() => handleSelect(option)}
              >
                <div class="custom-select-option-content">
                  <div class="custom-select-option-main">
                    <span class="custom-select-option-label">{option.label}</span>
                    {option.badge && <span class="chip">{option.badge}</span>}
                  </div>
                  {option.description && (
                    <div class="custom-select-option-desc">{option.description}</div>
                  )}
                </div>
                {isSelected && (
                  <svg
                    class="custom-select-check"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

