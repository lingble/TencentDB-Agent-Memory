/**
 * MarkdownView — unified Markdown rendering component.
 *
 * Pages like Skill details / Memory details share the same rendering and display style:
 * ReactMarkdown + remark-gfm, wrapped in a Tea token bordered box
 * (see markdown-view.css), without tailwind semantic colors or inline styles.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import './markdown-view.css';

export function MarkdownView({ children, className, bare }: { children: string; className?: string; bare?: boolean }) {
  return (
    <div className={`_md-view${bare ? ' _md-view--bare' : ''} prose prose-slate max-w-none${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
