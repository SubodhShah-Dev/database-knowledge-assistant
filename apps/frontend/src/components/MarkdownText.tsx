import type { ReactNode } from 'react';

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'table'; header: string[]; rows: string[][]; align: Array<'left' | 'center' | 'right'> };

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<em key={match.index}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function isSeparator(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function alignmentFor(line: string): Array<'left' | 'center' | 'right'> {
  return splitRow(line).map(cell => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function startsBlock(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^[-*+]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    /^>\s?/.test(line)
  );
}

function parse(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isSeparator(lines[index + 1])) {
      const header = splitRow(line);
      const align = alignmentFor(lines[index + 1]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows, align });
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'quote', text: body.join(' ') });
      continue;
    }

    const body: string[] = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !startsBlock(lines[index]) &&
      !(lines[index].includes('|') && index + 1 < lines.length && isSeparator(lines[index + 1]))
    ) {
      body.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: body.join(' ') });
  }

  return blocks;
}

export default function MarkdownText({ text }: { text: string }) {
  const blocks = parse(text);

  return (
    <div className="answer-text">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Tag = block.level <= 2 ? 'h3' : 'h4';
          return <Tag key={index}>{inline(block.text)}</Tag>;
        }
        if (block.type === 'code') {
          return (
            <pre className="answer-code" key={index}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'quote') {
          return <blockquote key={index}>{inline(block.text)}</blockquote>;
        }
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </Tag>
          );
        }
        if (block.type === 'table') {
          return (
            <div className="answer-table-wrap" key={index}>
              <table>
                <thead>
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? 'left' }}>
                        {inline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? 'left' }}>
                          {inline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </div>
  );
}
