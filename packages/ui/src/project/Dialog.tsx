import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  /** Escape and the backdrop close the dialog when this is set. */
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
  wide?: boolean;
}

/** A modal dialog: focus moves into it, Escape closes it when it can be closed. */
export function Dialog({ title, onClose, children, footer, testId, wide }: Props) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('button, input, select')?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="cgv-dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}
    >
      <div
        ref={box}
        className={'cgv-dialog' + (wide ? ' cgv-dialog-wide' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="cgv-dialog-body">{children}</div>
        {footer && <div className="cgv-dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
