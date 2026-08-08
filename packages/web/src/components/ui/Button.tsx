import type { ComponentProps } from 'preact';

interface ButtonProps extends ComponentProps<'button'> {
  variant?: 'primary' | 'secondary' | 'teal' | 'danger';
}

export function Button({ variant = 'primary', class: className, ...props }: ButtonProps) {
  const variantClass = variant === 'primary' ? '' : variant;
  return (
    <button 
      class={`btn ${variantClass} ${className || ''}`.trim()} 
      {...props} 
    />
  );
}

export function LinkButton({ class: className, ...props }: ComponentProps<'button'>) {
  return <button class={`link-btn ${className || ''}`.trim()} {...props} />;
}
