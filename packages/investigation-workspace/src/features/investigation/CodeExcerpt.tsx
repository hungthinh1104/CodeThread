type Props = {
  text: string;
  startLine: number;
  focusable?: boolean;
};

export function CodeExcerpt({ text, startLine, focusable = false }: Props) {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.length ? normalized.split('\n') : [''];
  const maxLineNumber = startLine + lines.length - 1;
  const gutterWidth = Math.max(2, String(maxLineNumber).length);

  return (
    <pre
      className="evidence-text"
      tabIndex={focusable ? 0 : undefined}
      style={{ ['--ct-gutter-ch' as string]: `${gutterWidth}ch` }}
    >
      {lines.map((line, index) => (
        <span className="code-line" key={`${startLine + index}-${index}`}>
          <span className="code-gutter" aria-hidden="true">
            {startLine + index}
          </span>
          <span className="code-content">{line || ' '}</span>
        </span>
      ))}
    </pre>
  );
}
