import type { EngineInterface, RenderElement } from 'claude-code'

import { renderMermaidASCII } from './vendor/mermaid-ascii.mjs'

type Els = ReturnType<EngineInterface['ui']['resolve']>

export type Block =
  | { kind: 'fence'; mark: string; lang: string; lines: string[] }
  | { kind: 'table'; lines: string[] }
  | { kind: 'text'; lines: string[] }

const FENCE = /^\s*(```+|~~~+)\s*([\w-]*)/
const TABLE_ROW = /^\s*\|.*\|\s*$/

/** Markdown split into fences, tables and text runs (blank lines end a text run). */
export function blocks(md: string): Block[] {
  const lines = md.replace(/\r/g, '').split('\n')
  const out: Block[] = []
  let text: string[] = []
  const flush = () => {
    if (text.some(l => l.trim() !== '')) out.push({ kind: 'text', lines: text })
    text = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const mark = fence[1] ?? '```'
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(mark)) body.push(lines[i++] ?? '')
      out.push({ kind: 'fence', mark, lang: (fence[2] ?? '').toLowerCase(), lines: body })
      continue
    }
    if (TABLE_ROW.test(line)) {
      flush()
      const rows: string[] = []
      while (i < lines.length && TABLE_ROW.test(lines[i] ?? '')) rows.push(lines[i++] ?? '')
      i--
      out.push({ kind: 'table', lines: rows })
      continue
    }
    if (line.trim() === '') flush()
    else text.push(line)
  }
  flush()

  return out
}

function toMarkdown(b: Block): string {
  if (b.kind === 'fence') return [b.mark + b.lang, ...b.lines, b.mark].join('\n')

  return b.lines.join('\n')
}

/** Rows a block takes once wrapped to `cols` (tables and fences do not wrap). */
function rowsOf(b: Block, cols: number): number {
  if (b.kind === 'fence') return b.lines.length + 2
  if (b.kind === 'table') return b.lines.length + 1

  return b.lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.max(10, cols))), 0)
}

/**
 * The leading blocks of `md` within about `budget` rendered rows at `cols`, never cut
 * inside a fence or table without closing it; diagrams become a one-line placeholder.
 */
export function excerpt(md: string, budget: number, cols: number): { text: string; isCut: boolean } {
  const all = blocks(md)
  const kept: string[] = []
  let used = 0
  let isCut = false

  for (const b of all) {
    const room = budget - used
    if (room <= 0) {
      isCut = true
      break
    }
    if (b.kind === 'fence' && b.lang === 'mermaid') {
      kept.push(`*◇ ${diagramKind(b.lines.join('\n'))} diagram · more to view*`)
      used += 2
      isCut = true
      continue
    }
    // a blank row separates blocks
    const size = rowsOf(b, cols) + (kept.length ? 1 : 0)
    if (size <= room) {
      kept.push(toMarkdown(b))
      used += size
      continue
    }
    // partial block: tables keep header + separator, fences stay closed, text cut by rows
    if (b.kind === 'table') {
      kept.push(b.lines.slice(0, Math.max(3, room - 1)).join('\n'))
    } else if (b.kind === 'fence') {
      kept.push([b.mark + b.lang, ...b.lines.slice(0, Math.max(1, room - 2)), b.mark].join('\n'))
    } else {
      const chars = Math.max(1, room) * Math.max(10, cols)
      const text = b.lines.join('\n')
      const cut = text.slice(0, chars - 1)
      const word = cut.lastIndexOf(' ')
      kept.push(text.length > chars ? `${(word > chars / 2 ? cut.slice(0, word) : cut).trimEnd()}…` : text)
    }
    isCut = true
    break
  }

  return { text: kept.join('\n\n'), isCut }
}

export function diagramKind(src: string): string {
  const head = src.trim().split(/\s/)[0]?.toLowerCase() ?? ''
  if (head === 'graph' || head === 'flowchart') return 'flowchart'
  if (head.startsWith('sequence')) return 'sequence'
  if (head.startsWith('class')) return 'class'
  if (head.startsWith('state')) return 'state'
  if (head.startsWith('er')) return 'ER'

  return 'mermaid'
}

export type Diagram = { lines: string[]; width: number; isClipped: boolean; error: string }

const cache = new Map<string, Diagram>()

function draw(src: string, tight: boolean): { lines: string[]; width: number } {
  const text = renderMermaidASCII(src, {
    colorMode: 'none',
    paddingX: tight ? 2 : 4,
    paddingY: tight ? 1 : 2,
    boxBorderPadding: tight ? 0 : 1,
  })
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  return { lines, width: lines.reduce((w, l) => Math.max(w, l.length), 0) }
}

/** Renders a mermaid source to fit `cols`: roomy, then tight, then left-right flipped top-down. */
export function diagram(src: string, cols: number): Diagram {
  const key = `${cols}\n${src}`
  const hit = cache.get(key)
  if (hit) return hit

  let best: { lines: string[]; width: number } | null = null
  let error = ''
  const flipped = src.replace(/^(\s*(?:graph|flowchart)\s+)(LR|RL)\b/m, '$1TD')
  const attempts: [string, boolean][] = [
    [src, false],
    [src, true],
    ...(flipped !== src ? ([[flipped, false], [flipped, true]] as [string, boolean][]) : []),
  ]
  for (const [source, tight] of attempts) {
    try {
      const d = draw(source, tight)
      if (!best || d.width < best.width) best = d
      if (d.width <= cols) break
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      break
    }
  }

  const result: Diagram = best
    ? { lines: best.lines, width: best.width, isClipped: best.width > cols, error: '' }
    : { lines: [], width: 0, isClipped: false, error: error || 'could not render' }
  if (cache.size > 64) cache.clear()
  cache.set(key, result)

  return result
}

function diagramNode(els: Els, src: string, cols: number, isDim: boolean): RenderElement {
  const { Box, Text, Markdown } = els
  const d = diagram(src, cols)
  if (d.error) {
    return (
      <Box flexDirection="column">
        <Markdown text={'```mermaid\n' + src + '\n```'} dimColor={isDim} />
        <Text dimColor wrap="truncate">
          mermaid: {d.error}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {d.lines.map(line => (
        <Text wrap="truncate-end" dimColor={isDim} color={isDim ? undefined : 'cyan'}>
          {line === '' ? ' ' : line}
        </Text>
      ))}
      {d.isClipped && <Text dimColor>diagram is {d.width} cols wide; widen the pane to see all</Text>}
    </Box>
  )
}

// ── tables: fitted to the pane, cells word-wrapped; too narrow for a grid, rows stack

type Align = 'left' | 'right' | 'center'
export type TableLine = { text: string; isHeader: boolean }

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return inner.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim())
}

/** Inline markdown reduced to the text a cell shows. */
export function cellText(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    let w = word
    while (w.length > width) {
      if (line) {
        out.push(line)
        line = ''
      }
      out.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!line) line = w
    else if (line.length + 1 + w.length <= width) line += ' ' + w
    else {
      out.push(line)
      line = w
    }
  }
  if (line || out.length === 0) out.push(line)

  return out
}

function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - text.length)
  if (align === 'right') return ' '.repeat(gap) + text
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(Math.ceil(gap / 2))

  return text + ' '.repeat(gap)
}

/** Column widths that fit `room`: narrow columns keep their width, wide ones share the rest. */
function fitWidths(natural: number[], room: number): number[] {
  const widths = natural.map(() => 0)
  let left = room
  let open = natural.map((_, i) => i)
  while (open.length) {
    const share = Math.floor(left / open.length)
    const fits = open.filter(i => (natural[i] ?? 0) <= share)
    if (fits.length === 0) {
      for (const i of open) widths[i] = share
      // spare cells from the floor go to the first columns
      let spare = left - share * open.length
      for (const i of open) if (spare-- > 0) widths[i] = (widths[i] ?? 0) + 1
      break
    }
    for (const i of fits) {
      widths[i] = natural[i] ?? 0
      left -= natural[i] ?? 0
    }
    open = open.filter(i => !fits.includes(i))
  }

  return widths.map(w => Math.max(1, w))
}

export function tableLines(rows: string[], cols: number): TableLine[] {
  const parsed = rows.map(splitRow)
  const sepAt = parsed.findIndex(r => r.length > 0 && r.every(c => /^:?-{1,}:?$/.test(c)))
  const header = sepAt === 1 ? (parsed[0] ?? []).map(cellText) : []
  const aligns: Align[] = (sepAt === 1 ? (parsed[1] ?? []) : []).map(c =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
  )
  const body = parsed.filter((_, i) => i !== sepAt && !(sepAt === 1 && i === 0)).map(r => r.map(cellText))
  const n = Math.max(header.length, ...body.map(r => r.length))
  const all = [header, ...body].filter(r => r.length)
  const natural = Array.from({ length: n }, (_, i) => Math.max(1, ...all.map(r => (r[i] ?? '').length)))
  const frame = 3 * n + 1
  const out: TableLine[] = []

  // too narrow for a readable grid: one block per row, `Header: value`
  if (cols - frame < n * 6) {
    body.forEach((row, ri) => {
      if (ri > 0) out.push({ text: '─'.repeat(Math.min(cols, 12)), isHeader: false })
      row.forEach((cell, ci) => {
        const label = header[ci] ? `${header[ci]}: ` : ''
        for (const l of wrapText(label + cell, cols)) out.push({ text: l, isHeader: false })
      })
    })
    return out
  }

  const widths = natural.reduce((a, b) => a + b, 0) + frame <= cols ? natural : fitWidths(natural, cols - frame)
  const rule = (l: string, m: string, r: string) => l + widths.map(w => '─'.repeat(w + 2)).join(m) + r
  const draw = (row: string[], isHeader: boolean) => {
    const cells = widths.map((w, i) => wrapText(row[i] ?? '', w))
    const height = Math.max(...cells.map(c => c.length))
    for (let li = 0; li < height; li++) {
      const text =
        '│' +
        widths.map((w, i) => ' ' + pad(cells[i]?.[li] ?? '', w, isHeader ? 'center' : (aligns[i] ?? 'left')) + ' ').join('│') +
        '│'
      out.push({ text, isHeader })
    }
  }

  out.push({ text: rule('┌', '┬', '┐'), isHeader: false })
  if (header.length) {
    draw(header, true)
    out.push({ text: rule('├', '┼', '┤'), isHeader: false })
  }
  for (const row of body) draw(row, false)
  out.push({ text: rule('└', '┴', '┘'), isHeader: false })

  return out
}

function tableNode(els: Els, rows: string[], cols: number, isDim: boolean): RenderElement {
  const { Box, Text } = els

  return (
    <Box flexDirection="column">
      {tableLines(rows, cols).map(l => (
        <Text wrap="truncate-end" bold={l.isHeader} dimColor={isDim}>
          {l.text === '' ? ' ' : l.text}
        </Text>
      ))}
    </Box>
  )
}

/** Markdown with mermaid fences drawn as diagrams; `budget` (source lines) gives an excerpt. */
export function rich(
  els: Els,
  md: string,
  cols: number,
  opts: { isDim?: boolean; budget?: number } = {},
): { node: RenderElement | false; isCut: boolean } {
  const { Box, Markdown } = els
  const { text, isCut } = opts.budget ? excerpt(md, opts.budget, cols) : { text: md, isCut: false }
  if (text.trim() === '') return { node: false, isCut: false }

  // consecutive non-diagram blocks render as one Markdown element
  const parts: RenderElement[] = []
  let run: string[] = []
  const flush = () => {
    if (run.length) parts.push(<Markdown text={run.join('\n\n').slice(0, 10_000)} dimColor={opts.isDim} />)
    run = []
  }
  for (const b of blocks(text)) {
    if (b.kind === 'fence' && b.lang === 'mermaid') {
      flush()
      parts.push(diagramNode(els, b.lines.join('\n'), cols, Boolean(opts.isDim)))
    } else if (b.kind === 'table') {
      flush()
      parts.push(tableNode(els, b.lines, cols, Boolean(opts.isDim)))
    } else {
      run.push(toMarkdown(b))
    }
  }
  flush()

  return { node: <Box flexDirection="column" rowGap={1}>{parts}</Box>, isCut }
}
