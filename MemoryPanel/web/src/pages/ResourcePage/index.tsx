/**
 * Generic shell for resource management pages - shared by Wiki / Code / Skills / Memory
 *
 * Content is shown normally for both admin and member
 * Wrapped externally by ConsoleLayout's Content.Body; this is a direct child.
 */
import type { ReactNode } from 'react';
import './styles/page-style.css';

export function ResourcePage({ children }: { children: ReactNode }) {
  return (
    <div className="_memory-page-body">
      {children}
    </div>
  );
}
