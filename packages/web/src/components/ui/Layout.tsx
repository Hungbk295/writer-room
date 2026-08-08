import type { ComponentProps } from 'preact';

export function Stack({ class: className, ...props }: ComponentProps<'div'>) {
  return <div class={`stack ${className || ''}`.trim()} {...props} />;
}

export function Row({ class: className, ...props }: ComponentProps<'div'>) {
  return <div class={`row ${className || ''}`.trim()} {...props} />;
}

export function Panel({ class: className, ...props }: ComponentProps<'article'>) {
  return <article class={`panel ${className || ''}`.trim()} {...props} />;
}

export function SectionHeading({ children, class: className, ...props }: ComponentProps<'div'>) {
  return (
    <div class={`section-heading ${className || ''}`.trim()} {...props}>
      {children}
    </div>
  );
}
