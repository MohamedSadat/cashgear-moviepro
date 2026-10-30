// Small line icons for the editing tools, drawn in the current text colour.
import type { ReactNode } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="cgv-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const icons = {
  select: (
    <Icon>
      <path d="M3 2l9 5.5-4 1 2.5 4.5-1.7.9L6.3 9.5 3 12.5z" />
    </Icon>
  ),
  blade: (
    <Icon>
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M5.4 10.6L12 2M10.6 10.6L4 2" />
    </Icon>
  ),
  split: (
    <Icon>
      <path d="M8 1.5v13M2 4h4v8H2M14 4h-4v8h4" />
    </Icon>
  ),
  trash: (
    <Icon>
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />
    </Icon>
  ),
  magnet: (
    <Icon>
      <path d="M3 2.5v5a5 5 0 0010 0v-5h-3v5a2 2 0 01-4 0v-5z" />
      <path d="M3 5h3M10 5h3" />
    </Icon>
  ),
  snap: (
    <Icon>
      <path d="M8 1.5v13" strokeDasharray="2 1.6" />
      <path d="M2 5.5h4.5v5H2M14 5.5H9.5v5H14" />
    </Icon>
  ),
  marker: (
    <Icon>
      <path d="M4 14.5V2h8l-2 3 2 3H4" />
    </Icon>
  ),
  zoomIn: (
    <Icon>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14M5 7h4M7 5v4" />
    </Icon>
  ),
  zoomOut: (
    <Icon>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14M5 7h4" />
    </Icon>
  ),
  fit: (
    <Icon>
      <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3M5 8h6M6.5 6.5L5 8l1.5 1.5M9.5 6.5L11 8 9.5 9.5" />
    </Icon>
  ),
  plus: (
    <Icon>
      <path d="M8 3v10M3 8h10" />
    </Icon>
  ),
  lock: (
    <Icon>
      <rect x="3.5" y="7" width="9" height="7" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </Icon>
  ),
  unlock: (
    <Icon>
      <rect x="3.5" y="7" width="9" height="7" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 014.8-1" />
    </Icon>
  ),
  microphone: (
    <Icon>
      <path d="M8 2a2 2 0 012 2v4a2 2 0 01-4 0V4a2 2 0 012-2zM4.5 7.5a3.5 3.5 0 007 0M8 11v3M6 14h4" />
    </Icon>
  ),
  sound: (
    <Icon>
      <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 5.5a3.5 3.5 0 010 5M12.5 3.5a6 6 0 010 9" />
    </Icon>
  ),
  muted: (
    <Icon>
      <path d="M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 6l3.5 4M14.5 6L11 10" />
    </Icon>
  ),
  eye: (
    <Icon>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </Icon>
  ),
  eyeOff: (
    <Icon>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM2.5 13.5l11-11" />
    </Icon>
  ),
  keyboard: (
    <Icon>
      <rect x="1.5" y="4" width="13" height="8" rx="1" />
      <path d="M4 6.5h.5M6.5 6.5H7M9 6.5h.5M11.5 6.5h.5M4.5 9.5h7" />
    </Icon>
  ),
  info: (
    <Icon>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.5V11.5M8 5V5.5" />
    </Icon>
  ),
};
