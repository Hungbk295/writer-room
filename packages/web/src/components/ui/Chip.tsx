import type { ComponentProps } from 'preact';

interface ChipProps extends ComponentProps<'span'> {
  variant?: 'default' | 'warn' | 'bad' | 'writer' | 'training' | 'other';
}

export function Chip({ variant = 'default', class: className, children, ...props }: ChipProps) {
  const variantClass = variant === 'default' ? '' : 
    (variant === 'writer' || variant === 'training' || variant === 'other') ? `chip-${variant}` : variant;
  return (
    <span class={`chip ${variantClass} ${className || ''}`.trim()} {...props}>
      {children}
    </span>
  );
}
