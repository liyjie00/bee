import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useState } from 'react';
import { MermaidPreview } from './Mermaid.js';
import { useMessages } from './i18n.js';

const LANGUAGES: [string, string][] = [
  // '' and 'mermaid' are labelled from messages.
  ['bash', 'Bash'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['css', 'CSS'],
  ['diff', 'Diff'],
  ['go', 'Go'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['json', 'JSON'],
  ['kotlin', 'Kotlin'],
  ['markdown', 'Markdown'],
  ['php', 'PHP'],
  ['python', 'Python'],
  ['ruby', 'Ruby'],
  ['rust', 'Rust'],
  ['sql', 'SQL'],
  ['swift', 'Swift'],
  ['typescript', 'TypeScript'],
  ['xml', 'HTML/XML'],
  ['yaml', 'YAML'],
];

/** Code block with language picker, copy button, line-number gutter and Mermaid preview. */
export function CodeBlockView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const language = (node.attrs.language as string | null) ?? '';
  const text = node.textContent;
  const lines = Math.max(1, text.split('\n').length);
  const isMermaid = language === 'mermaid';
  const [showSource, setShowSource] = useState(!text);
  const [copied, setCopied] = useState(false);
  const t = useMessages();
  const options: [string, string][] = [['', t.plainText], ['mermaid', t.mermaidLabel], ...LANGUAGES];
  const known = options.some(([v]) => v === language);

  const copy = async () => {
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <NodeViewWrapper className={`bee-code${isMermaid ? ' bee-code-mermaid' : ''}`} data-language={language}>
      <div className="bee-code-header" contentEditable={false}>
        {editor.isEditable ? (
          <select
            className="bee-code-lang"
            value={language}
            onChange={(e) => updateAttributes({ language: e.target.value || null })}
            aria-label={t.codeLanguage}
          >
            {!known && <option value={language}>{language}</option>}
            {options.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        ) : (
          <span className="bee-code-lang">{options.find(([v]) => v === language)?.[1] ?? language}</span>
        )}
        <span className="bee-code-actions">
          {isMermaid && (
            <button type="button" onClick={() => setShowSource((s) => !s)}>
              {showSource ? t.hideSource : t.editSource}
            </button>
          )}
          <button type="button" onClick={copy}>
            {copied ? t.copied : t.copy}
          </button>
        </span>
      </div>
      <div className="bee-code-body" hidden={isMermaid && !showSource}>
        <div className="bee-code-gutter" contentEditable={false} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <pre spellCheck={false}>
          <NodeViewContent<'code'> as="code" />
        </pre>
      </div>
      {isMermaid && (
        <div className="bee-code-preview" contentEditable={false}>
          <MermaidPreview code={text} />
        </div>
      )}
    </NodeViewWrapper>
  );
}
