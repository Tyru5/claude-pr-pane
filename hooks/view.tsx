import type { EngineInterface, RenderElement } from 'claude-code'

import type { CheckState, GreptileScore, MineFilter, PrCheck, PrMerge, PrComment, PrSection, PrEntry, PrListItem, PrMine, PrSnapshot, PrThread, PrTrack, PrView } from '../types'
import { MINE_FILTERS, ago, greptileColor, isConflicting, checkCounts, cleanBody, clip, isFilterMatch, isQueryMatch, preview, reviewVerb } from './gh'
import { rich } from './md'

type Els = ReturnType<EngineInterface['ui']['resolve']>
type Node = RenderElement

/** wide: workflow column + bordered cards; narrow: single column; tiny: bare minimum */
export type Tier = 'wide' | 'narrow' | 'tiny'

export type Layout = {
  cols: number
  tier: Tier
  /** too short to scroll comfortably (inline above the prompt): summary only */
  isCompact: boolean
  isFocused: boolean
  /** the footer pins to the window's bottom edge (terminal, tall enough) */
  isSticky: boolean
  /** first tree row the window shows, and how many it shows */
  offset: number
  bodyRows: number
}

export type Actions = {
  refresh: () => void
  toggleView: (key: 'isExpanded' | 'isBotsHidden' | 'isResolvedShown' | 'isMoreKeys') => void
  toggleOpen: (id: string) => void
  /** fold / unfold a section, or draw it in full / back to its excerpt */
  toggleSection: (name: PrSection, list: 'closedSections' | 'fullSections') => void
  openSections: () => void
  /** conflicts: hand them to Claude; else ask to confirm, with the repo's methods */
  merge: (pr: PrSnapshot) => void
  confirmMerge: (pr: PrSnapshot) => void
  cycleMethod: () => void
  cancelMerge: () => void
  fix: (pr: PrSnapshot) => void
  /** one failing check: hand it to Claude with T3 Code's prompt */
  fixCheck: (pr: PrSnapshot, check: PrCheck) => void
  /** the PR in the default browser (`gh pr view --web`) */
  openWeb: (pr: PrSnapshot) => void
  close: () => void
  select: (key: string) => void
  unpin: (key: string) => void
  /** a Mine row: its tab when it has one, else it opens as the peek */
  pick: (item: PrListItem) => void
  /** keep the peek as a pinned tab */
  pinPeek: () => void
  setQuery: (query: string) => void
  /** Enter in the search: one hit opens, several put the ring on the first */
  submitSearch: (query: string, hits: PrListItem[]) => void
  focusSearch: () => void
  setFilter: (filter: MineFilter) => void
}

/** One tab: Mine, the branch's PR, or a pin. */
export type Tab = { key: string; label: string; glyph: string; color: string; greptile?: GreptileScore | null; isPeek?: boolean }

export type Model = {
  entries: Record<string, PrEntry>
  track: PrTrack
  mine: PrMine
  view: PrView
  merge: PrMerge
  now: number
  command: string
  tabs: Tab[]
  /** the tab drawn: always one of `tabs` */
  selected: string
  /** the search field's key: a new one after each Enter, since the field empties on submit and only a new element draws the query back */
  searchKey: string
}

export const MINE = 'mine'
export const BRANCH = 'branch'

export function layoutFor(
  bodyColumns: number,
  bodyRows: number,
  isFocused: boolean,
  opts: { offset?: number; isTerminal?: boolean } = {},
): Layout {
  // one cell of padding each side
  const cols = Math.max(16, bodyColumns - 2)
  const tier: Tier = cols >= 56 ? 'wide' : cols >= 34 ? 'narrow' : 'tiny'
  const isCompact = bodyRows > 0 && bodyRows < 14
  // remote surfaces scroll the body themselves: there the footer stays in the flow
  const isSticky = Boolean(opts.isTerminal) && bodyRows > 0 && !isCompact

  return { cols, tier, isCompact, isFocused, isSticky, offset: opts.offset ?? 0, bodyRows }
}

function glyphOf(e: PrEntry | undefined): { glyph: string; color: string } {
  if (!e || e.status === 'loading') return { glyph: '…', color: 'gray' }
  if (e.status === 'error') return { glyph: '!', color: 'red' }
  const pr = e.pr
  if (!pr) return { glyph: '○', color: 'gray' }
  if (pr.state === 'MERGED') return { glyph: 'M', color: 'magenta' }
  if (pr.state === 'CLOSED') return { glyph: '×', color: 'gray' }
  const n = checkCounts(pr.checks)
  if (n.fail) return { glyph: '✗', color: 'red' }
  if (n.pending) return { glyph: '●', color: 'yellow' }
  if (n.pass) return { glyph: '✓', color: 'green' }

  return { glyph: '○', color: 'gray' }
}

function pinLabel(key: string, e: PrEntry | undefined): string {
  if (e?.pr) return `#${e.pr.number}`
  const m = /\/pull\/(\d+)/.exec(key)

  return `#${m ? m[1] : key}`
}

/** Mine first, then the branch's PR (when it has one), pins, the peek; a PR shown twice keeps its first tab. */
export function tabsOf(entries: Record<string, PrEntry>, track: PrTrack): Tab[] {
  const tabs: Tab[] = [{ key: MINE, label: 'mine', glyph: '', color: '' }]
  const seen = new Set<string>()
  const branch = entries[BRANCH]
  if (branch && branch.status !== 'none') {
    if (branch.pr) seen.add(branch.pr.url)
    tabs.push({
      key: BRANCH,
      label: `⎇ ${branch.pr ? `#${branch.pr.number}` : track.branch || 'branch'}`,
      ...glyphOf(branch),
      greptile: branch.pr?.greptile,
    })
  }
  for (const key of track.pins) {
    const e = entries[key]
    if (e?.pr) {
      if (seen.has(e.pr.url)) continue
      seen.add(e.pr.url)
    }
    tabs.push({ key, label: pinLabel(key, e), ...glyphOf(e), greptile: e?.pr?.greptile })
  }
  const peek = track.peek ?? ''
  const e = entries[peek]
  if (peek && !track.pins.includes(peek) && !(e?.pr && seen.has(e.pr.url))) {
    tabs.push({ key: peek, label: `◇${pinLabel(peek, e)}`, ...glyphOf(e), greptile: e?.pr?.greptile, isPeek: true })
  }

  return tabs
}

/** The tab asked for when it exists; else the branch's PR, the first pin, Mine. */
export function selectedOf(tabs: Tab[], wanted: string): string {
  if (tabs.some(t => t.key === wanted)) return wanted

  return (tabs.find(t => t.key === BRANCH) ?? tabs[1] ?? tabs[0])?.key ?? MINE
}

const ICON: Record<CheckState, string> = { pass: '✓', fail: '✗', pending: '●', skip: '⊘', neutral: '○' }
const COLOR: Record<CheckState, string> = { pass: 'green', fail: 'red', pending: 'yellow', skip: 'gray', neutral: 'gray' }

const REVIEW_COLOR: Record<string, string> = {
  APPROVED: 'green',
  CHANGES_REQUESTED: 'red',
  REQUESTED: 'yellow',
  PENDING: 'yellow',
}

const DECISION: Record<string, { label: string; short: string; color: string }> = {
  APPROVED: { label: 'approved', short: 'approved', color: 'green' },
  CHANGES_REQUESTED: { label: 'changes requested', short: 'changes', color: 'red' },
  REVIEW_REQUIRED: { label: 'review required', short: 'required', color: 'yellow' },
}

const MERGE: Record<string, { label: string; color: string }> = {
  CLEAN: { label: 'ready to merge', color: 'green' },
  HAS_HOOKS: { label: 'ready to merge', color: 'green' },
  UNSTABLE: { label: 'mergeable · checks failing', color: 'yellow' },
  BLOCKED: { label: 'merge blocked', color: 'yellow' },
  BEHIND: { label: 'behind base branch', color: 'yellow' },
  DIRTY: { label: 'merge conflicts', color: 'red' },
}

function badgeOf(pr: PrSnapshot): { label: string; color: string } {
  if (pr.state === 'MERGED') return { label: 'MERGED', color: 'magenta' }
  if (pr.state === 'CLOSED') return { label: 'CLOSED', color: 'red' }
  if (pr.isDraft) return { label: 'DRAFT', color: 'gray' }

  return { label: 'OPEN', color: 'green' }
}

function clockOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')

  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function isFresh(iso: string, now: number): boolean {
  const t = Date.parse(iso)

  return !Number.isNaN(t) && now - t < 10 * 60_000
}

/** Everything a section header and the compact view say, computed once. */
function summaries(pr: PrSnapshot, isOpen: boolean) {
  const counts = checkCounts(pr.checks)
  const ran = pr.checks.length - counts.skip
  const checks =
    pr.checks.length === 0
      ? { text: 'none', color: undefined }
      : counts.fail
        ? { text: `${counts.fail} failing`, color: 'red' }
        : counts.pending
          ? { text: `${counts.pending} running`, color: 'yellow' }
          : { text: `${counts.pass}/${ran} passed`, color: 'green' }
  const decision = isOpen ? DECISION[pr.reviewDecision] : undefined
  const unresolved = pr.threads.filter(t => !t.isResolved).length
  const threads =
    pr.threads.length === 0
      ? { text: 'none', color: undefined }
      : unresolved
        ? { text: `${unresolved} unresolved`, color: 'yellow' }
        : { text: 'all resolved', color: 'green' }

  return { counts, checks, decision, unresolved, threads }
}

/** `Checks ─────── 4/4 passed`; the rule shrinks first, then the summary truncates. */
function isClosed(m: Model, name: PrSection): boolean {
  return (m.view.closedSections ?? []).includes(name)
}

/** Global expand, or this section drawn in full. */
function isFull(m: Model, name: PrSection): boolean {
  return m.view.isExpanded || (m.view.fullSections ?? []).includes(name)
}

/**
 * `▾ Checks ─────── 4/4 passed`; the rule shrinks first, then the summary truncates.
 * The label is a Button: pressing it folds the section to this row, or unfolds it.
 */
function section(els: Els, L: Layout, m: Model, a: Actions, name: PrSection, summary: string, color?: string): Node {
  const { Box, Text, Button } = els
  const label = `${isClosed(m, name) ? '▸' : '▾'} ${name}`
  const fill = L.cols - label.length - summary.length - 2

  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexShrink={0}>
        <Button key={`sec:${name}`} plain label={label} onPress={() => a.toggleSection(name, 'closedSections')} />
      </Box>
      {fill >= 2 && (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{'─'.repeat(fill)}</Text>
        </Box>
      )}
      <Box flexGrow={fill >= 2 ? 0 : 1} flexShrink={1} marginLeft={1} justifyContent="flex-end">
        <Text color={color} dimColor={!color} wrap="truncate">
          {summary}
        </Text>
      </Box>
    </Box>
  )
}

/** `+3 passing` / `less`: draws one section in full, or back to its excerpt. */
function moreButton(els: Els, m: Model, a: Actions, name: PrSection, label: string): Node {
  const { Button } = els
  const isOn = (m.view.fullSections ?? []).includes(name)

  return (
    <Button
      key={`full:${name}`}
      plain
      dimColor
      label={isOn ? '▴ less' : `▸ ${label}`}
      onPress={() => a.toggleSection(name, 'fullSections')}
    />
  )
}

/** A thread or comment: bordered card when wide, flush block otherwise. */
function card(els: Els, L: Layout, isFirst: boolean, children: Node[]): Node {
  const { Box } = els

  return L.tier === 'wide' ? (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      {children}
    </Box>
  ) : (
    <Box flexDirection="column" marginTop={isFirst ? 0 : 1}>
      {children}
    </Box>
  )
}

/** Room a card's text gets inside its border and the body indent. */
function innerCols(L: Layout): number {
  return L.tier === 'wide' ? L.cols - 4 : L.cols
}

/** A comment body as rendered markdown (diagrams drawn); collapsed, an excerpt of its first blocks. */
function bodyBlock(els: Els, L: Layout, body: string, isOpen: boolean, isDim: boolean): Node | false {
  const { Box } = els
  const indent = L.tier === 'wide' ? 0 : 2
  const budget = isOpen ? undefined : L.tier === 'tiny' ? 3 : 5
  const { node } = rich(els, cleanBody(body), innerCols(L) - indent, { isDim, budget })

  return node !== false && <Box paddingLeft={indent}>{node}</Box>
}

/** The PR description: an excerpt with a more/less toggle, or the whole when opened. */
function description(els: Els, L: Layout, m: Model, pr: PrSnapshot, a: Actions): Node[] {
  const { Box } = els
  const body = cleanBody(pr.body)
  if (body === '') return [section(els, L, m, a, 'Description', 'empty')]
  if (isClosed(m, 'Description')) return [section(els, L, m, a, 'Description', '')]
  const isOpen = isFull(m, 'Description')
  const { node, isCut } = rich(els, body, L.cols, { budget: isOpen ? undefined : L.tier === 'wide' ? 10 : 6 })

  return [
    section(els, L, m, a, 'Description', ''),
    node || <Box />,
    ...(isCut || (m.view.fullSections ?? []).includes('Description') ? [moreButton(els, m, a, 'Description', 'more')] : []),
  ]
}

/** `▸` / `▾` pressable glyph that opens one item; nothing when there is nothing more to show. */
function toggle(els: Els, id: string, isOpen: boolean, a: Actions): Node {
  const { Button } = els

  return <Button key={`open:${id}`} plain label={isOpen ? '▾' : '▸'} dimColor onPress={() => a.toggleOpen(id)} />
}

function threadCard(els: Els, L: Layout, m: Model, t: PrThread, isFirst: boolean, a: Actions): Node {
  const { Box, Text } = els
  const first = t.comments[0]
  const isOpen = isFull(m, 'Threads') || (m.view.openIds ?? []).includes(t.id)
  const replies = t.comments.slice(1)
  const where = `${t.path}${t.line ? `:${t.line}` : ''}`
  const state = t.isResolved ? 'resolved' : t.isOutdated ? 'outdated' : ''

  return card(els, L, isFirst, [
    <Box flexDirection="row">
      {toggle(els, t.id, isOpen, a)}
      <Box flexGrow={1} flexShrink={1} marginLeft={1}>
        <Text wrap="truncate-start" color={t.isResolved ? 'gray' : 'cyan'}>
          {where}
        </Text>
      </Box>
      {state !== '' && L.tier !== 'tiny' && (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{state}</Text>
        </Box>
      )}
    </Box>,
    first ? (
      <Text wrap="truncate">
        <Text bold dimColor={t.isResolved}>
          @{first.author}
        </Text>
        <Text dimColor> {ago(first.createdAt, m.now)}</Text>
        {replies.length > 0 && <Text dimColor> · {replies.length}↩</Text>}
        {isFresh(first.createdAt, m.now) && <Text color="yellow"> new</Text>}
      </Text>
    ) : (
      <Text dimColor>empty thread</Text>
    ),
    first ? bodyBlock(els, L, first.body, isOpen, t.isResolved) : false,
    // replies only when opened: header + body each
    ...(isOpen
      ? replies.map(r => (
          <Box flexDirection="column" marginTop={1} paddingLeft={2}>
            <Text wrap="truncate">
              <Text bold>↳ @{r.author}</Text>
              <Text dimColor> {ago(r.createdAt, m.now)}</Text>
            </Text>
            {bodyBlock(els, L, r.body, true, t.isResolved)}
          </Box>
        ))
      : []),
  ].filter(Boolean) as Node[])
}

function commentCard(els: Els, L: Layout, m: Model, c: PrComment, isFirst: boolean, a: Actions): Node {
  const { Box, Text, Link } = els
  const isOpen = isFull(m, 'Comments') || (m.view.openIds ?? []).includes(c.id)
  // bots collapse to their header until opened: their bodies are long and repetitive
  const showBody = isOpen || !c.isBot

  return card(els, L, isFirst, [
    <Box flexDirection="row">
      {toggle(els, c.id, isOpen, a)}
      <Box flexGrow={1} flexShrink={1} marginLeft={1}>
        <Text wrap="truncate">
          <Text bold dimColor={c.isBot}>
            @{c.author}
          </Text>
          {c.kind === 'review' && L.tier !== 'tiny' && (
            <Text color={REVIEW_COLOR[c.reviewState] ?? undefined}> {reviewVerb(c.reviewState)}</Text>
          )}
          {isFresh(c.createdAt, m.now) && <Text color="yellow"> new</Text>}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Text dimColor>{ago(c.createdAt, m.now)}</Text>
      </Box>
      {c.url && L.tier !== 'tiny' && (
        <Box flexShrink={0} marginLeft={1}>
          <Link href={c.url} label="↗" />
        </Box>
      )}
    </Box>,
    showBody ? bodyBlock(els, L, c.body, isOpen, c.isBot) : false,
  ].filter(Boolean) as Node[])
}

/** One footer option: a plain hotkey Button. */
type Key = {
  key: string
  hotkey: string
  label: string
  onPress: () => void
  isDismiss?: boolean
  /** `view` keys sit on the second row, behind `k: more` */
  group?: 'act' | 'view'
  /** a toggle that is off: drawn dim */
  isOff?: boolean
}

/** Packs options into rows of the pane's width, as a plain Button draws them (`r: refresh`). */
export function packKeys<K extends { hotkey: string; label: string }>(keys: K[], cols: number, gap = 2): K[][] {
  const rows: K[][] = []
  let row: K[] = []
  let used = 0
  for (const k of keys) {
    const w = k.hotkey.length + 2 + k.label.length
    if (row.length && used + gap + w > cols) {
      rows.push(row)
      row = []
      used = 0
    }
    used += (row.length ? gap : 0) + w
    row.push(k)
  }
  if (row.length) rows.push(row)

  return rows
}

function prKeys(L: Layout, m: Model, pr: PrSnapshot | null, a: Actions): Key[] {
  const v = m.view
  if (pr && m.merge.key === m.selected && m.merge.status !== 'idle') {
    // confirming: the footer is the question alone
    if (m.merge.status === 'merging') return [{ key: 'merging', hotkey: 'n', label: `merging (${m.merge.method})…`, onPress: () => undefined }]
    const others = m.merge.methods.length > 1
    return [
      { key: 'confirm-merge', hotkey: 'y', label: `confirm ${m.merge.method} merge`, onPress: () => a.confirmMerge(pr) },
      ...(others ? [{ key: 'method', hotkey: 'v', label: 'method', onPress: a.cycleMethod }] : []),
      { key: 'cancel-merge', hotkey: 'n', label: 'cancel', onPress: a.cancelMerge },
    ]
  }
  // first row acts on the PR; the view toggles wait behind `k: more`
  const out: Key[] = [{ key: 'refresh', hotkey: 'r', label: 'refresh', onPress: a.refresh }]
  if (pr) {
    const s = summaries(pr, pr.state === 'OPEN')
    out.push({ key: 'open', hotkey: 'o', label: 'open', onPress: () => a.openWeb(pr) })
    if (pr.state === 'OPEN' && !pr.isDraft) {
      out.push({ key: 'merge', hotkey: 'm', label: isConflicting(pr) ? 'resolve' : 'merge', onPress: () => a.merge(pr) })
    }
    if (pr.state === 'OPEN' && (s.counts.fail > 0 || s.unresolved > 0)) {
      out.push({ key: 'fix', hotkey: 'f', label: 'fix', onPress: () => a.fix(pr) })
    }
  }
  const isPeek = m.selected === (m.track.peek ?? '')
  if (isPeek) out.push({ key: 'pin', hotkey: 'p', label: 'pin', onPress: a.pinPeek })
  if (m.selected !== BRANCH) out.push({ key: 'unpin', hotkey: 'x', label: isPeek ? 'close tab' : 'unpin', onPress: () => a.unpin(m.selected) })

  const view: Key[] = []
  if (pr) {
    view.push({
      key: 'expand',
      hotkey: 'e',
      label: L.isCompact ? 'details' : v.isExpanded ? 'collapse' : 'expand',
      onPress: () => a.toggleView('isExpanded'),
    })
    if (!L.isCompact) {
      view.push(
        { key: 'bots', hotkey: 'b', label: 'bots', isOff: v.isBotsHidden, onPress: () => a.toggleView('isBotsHidden') },
        { key: 'resolved', hotkey: 't', label: 'resolved', isOff: !v.isResolvedShown, onPress: () => a.toggleView('isResolvedShown') },
      )
      if ((v.closedSections ?? []).length > 0) view.push({ key: 'sections', hotkey: 's', label: 'unfold', onPress: a.openSections })
    }
  }
  view.push({ key: 'close', hotkey: 'q', label: 'close', onPress: a.close, isDismiss: true })
  out.push({ key: 'more', hotkey: 'k', label: v.isMoreKeys ? 'less' : 'more', onPress: () => a.toggleView('isMoreKeys') })

  return [...out, ...view.map(k => ({ ...k, group: 'view' as const }))]
}

function mineKeys(els: Els, m: Model, a: Actions): Key[] {
  const v = m.view
  const out: Key[] = [{ key: 'refresh', hotkey: 'r', label: 'refresh', onPress: a.refresh }]
  if ('Input' in els) out.push({ key: 'find', hotkey: 's', label: 'search', onPress: a.focusSearch })
  if ((v.query ?? '') !== '' || (v.filter ?? 'all') !== 'all') {
    out.push({
      key: 'clear',
      hotkey: 'c',
      label: 'clear search',
      onPress: () => {
        a.setQuery('')
        a.setFilter('all')
      },
    })
  }
  out.push({ key: 'close', hotkey: 'q', label: 'close', onPress: a.close, isDismiss: true })

  return out
}

/** `─ 10:02 · feat/x · tab tab ──────`: the status folded into the footer's rule. */
function ruleWith(els: Els, L: Layout, status: string, isError: boolean): Node {
  const { Box, Text } = els
  const hint = !L.isFocused && L.tier !== 'tiny' ? ' · tab tab' : ''
  const text = clip(`${status}${hint}`, Math.max(4, L.cols - 6))
  const fill = Math.max(2, L.cols - text.length - 3)

  return (
    <Box flexDirection="row" height={1}>
      <Text dimColor>{'─ '}</Text>
      <Text dimColor={!isError} color={isError ? 'red' : undefined}>
        {text}
      </Text>
      <Text dimColor>{` ${'─'.repeat(fill)}`}</Text>
    </Box>
  )
}

/**
 * The footer's rows, each exactly one line tall: the rule carrying the status,
 * the actions, then (after `k: more`) the view toggles; a toggle that is off is dim.
 */
function footerRows(els: Els, L: Layout, m: Model, keys: Key[], status: string, isError: boolean): Node[] {
  const { Box, Button } = els
  const rows: Node[] = [ruleWith(els, L, status, isError)]
  const groups = [keys.filter(k => k.group !== 'view'), m.view.isMoreKeys ? keys.filter(k => k.group === 'view') : []]
  for (const group of groups) {
    for (const row of packKeys(group, L.cols)) {
      rows.push(
        <Box flexDirection="row" columnGap={2} height={1}>
          {row.map(k => (
            <Button
              key={k.key}
              plain
              hotkey={k.hotkey}
              label={k.label}
              dimColor={k.isOff}
              onPress={k.onPress}
              {...(k.isDismiss ? { role: 'dismiss' as const } : {})}
            />
          ))}
        </Box>,
      )
    }
  }

  return rows
}

/**
 * Content above, options below. Sticky: the footer is laid absolute at the
 * window's bottom edge (offset + rows), over a blank of its own height, and the
 * content gets as much padding below so its last row scrolls clear of it.
 */
function frame(els: Els, L: Layout, content: Node[], footer: Node[]): Node {
  const { Box, Text } = els
  if (!L.isSticky) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {content}
        <Box flexDirection="column" marginTop={L.isCompact ? 0 : 1}>
          {footer}
        </Box>
      </Box>
    )
  }
  const fh = footer.length
  const blank = ' '.repeat(L.cols + 2)

  return (
    <Box flexDirection="column" minHeight={L.bodyRows}>
      <Box flexDirection="column" paddingX={1} paddingBottom={fh}>
        {content}
      </Box>
      <Box position="absolute" top={Math.max(0, L.offset + L.bodyRows - fh)} left={0} right={0} flexDirection="column">
        <Box position="absolute" top={0} left={0} flexDirection="column">
          {Array.from({ length: fh }, () => (
            <Text>{blank}</Text>
          ))}
        </Box>
        <Box flexDirection="column" paddingX={1}>
          {footer}
        </Box>
      </Box>
    </Box>
  )
}

/** `1: mine  2: ⎇ #12 ✓  3: #34 ✗`: digits jump, the drawn tab marked. */
function tabBar(els: Els, L: Layout, m: Model, a: Actions): Node {
  const { Box, Text, Button } = els

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {m.tabs.map((t, i) => {
        const isOn = t.key === m.selected
        const hotkey = i < 9 ? String(i + 1) : undefined

        return (
          <Box flexDirection="row" flexShrink={0}>
            <Text color="cyan">{isOn ? '▸' : ' '}</Text>
            <Button
              key={`tab:${t.key}`}
              plain
              {...(hotkey ? { hotkey } : {})}
              dimColor={!isOn}
              label={L.tier === 'tiny' && t.key === MINE ? 'me' : t.label}
              onPress={() => a.select(t.key)}
            />
            {t.glyph !== '' && <Text color={t.color}> {t.glyph}</Text>}
            {t.greptile && <Text color={greptileColor(t.greptile)}> {t.greptile.score}/{t.greptile.of}</Text>}
          </Box>
        )
      })}
    </Box>
  )
}

function itemGlyph(it: PrListItem): { glyph: string; color: string } {
  if (it.fail) return { glyph: '✗', color: 'red' }
  if (it.pending) return { glyph: '●', color: 'yellow' }
  if (it.pass) return { glyph: '✓', color: 'green' }

  return { glyph: '○', color: 'gray' }
}

/** The person's open PRs: search, filter, press one to open it in a tab. */
function mineBody(els: Els, L: Layout, m: Model, a: Actions): Node[] {
  const { Box, Text, Button } = els
  const v = m.view
  const query = v.query ?? ''
  const filter = v.filter ?? 'all'
  const items = m.mine.items
  const hits = items.filter(it => isFilterMatch(it, filter) && isQueryMatch(it, query))
  const isWide = L.tier === 'wide'
  const out: Node[] = []

  if (!L.isCompact) {
    if ('Input' in els) {
      const { Input } = els
      out.push(
        <Input
          key={m.searchKey}
          label="search "
          placeholder="title, branch or #number"
          value={query}
          submitLabel={hits.length === 1 ? 'open' : 'to list'}
          onInput={q => a.setQuery(q)}
          onSubmit={q => a.submitSearch(q, items.filter(it => isFilterMatch(it, filter) && isQueryMatch(it, q)))}
        />,
      )
    }
    // filters as chips, not a Select: arrowing up the list onto a Select pops it open and traps the arrows
    out.push(
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {MINE_FILTERS.map(f => ({ ...f, n: items.filter(it => isFilterMatch(it, f.value)).length }))
          .filter(f => f.value === 'all' || f.value === filter || f.n > 0)
          .map(f => (
            <Box flexDirection="row" flexShrink={0}>
              <Text color="cyan">{f.value === filter ? '▸' : ' '}</Text>
              <Button
                key={`filter:${f.value}`}
                plain
                dimColor={f.value !== filter}
                label={`${f.label} ${f.n}`}
                onPress={() => a.setFilter(f.value)}
              />
            </Box>
          ))}
      </Box>,
    )
  }

  const branch = m.entries[BRANCH]
  const note =
    m.mine.status === 'error'
      ? `gh failed: ${clip(m.mine.error, 200)}`
      : m.mine.fetchedAt === 0
        ? 'Loading your pull requests…'
        : `${hits.length} of ${items.length} open${branch?.status === 'none' && m.track.branch ? ` · ${m.track.branch}: no PR` : ''}`
  out.push(
    <Box marginTop={L.isCompact ? 0 : 1}>
      <Text dimColor={m.mine.status !== 'error'} color={m.mine.status === 'error' ? 'red' : undefined} wrap="truncate">
        {note}
      </Text>
    </Box>,
  )

  const rows = L.isCompact ? hits.slice(0, 3) : hits
  for (const it of rows) {
    const g = itemGlyph(it)
    const decision = DECISION[it.reviewDecision]
    const tail = ago(it.updatedAt, m.now)
    const score = it.greptile ? `${it.greptile.score}/${it.greptile.of}` : ''
    const room =
      L.cols - 2 - (tail.length + 1) - (isWide && decision ? decision.short.length + 1 : 0) - (score ? score.length + 1 : 0)
    out.push(
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text color={g.color}>{g.glyph} </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Button
            key={`mine:${it.number}`}
            plain
            dimColor={it.isDraft}
            label={clip(`#${it.number} ${it.title}`, Math.max(8, room))}
            onPress={() => a.pick(it)}
          />
        </Box>
        {isWide && decision && (
          <Box flexShrink={0} marginLeft={1}>
            <Text color={decision.color}>{decision.short}</Text>
          </Box>
        )}
        {it.greptile && (
          <Box flexShrink={0} marginLeft={1}>
            <Text color={greptileColor(it.greptile)}>{score}</Text>
          </Box>
        )}
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{tail}</Text>
        </Box>
      </Box>,
    )
  }
  if (L.isCompact && hits.length > rows.length) out.push(<Text dimColor>+{hits.length - rows.length} more</Text>)
  if (m.mine.fetchedAt > 0 && items.length > 0 && hits.length === 0) out.push(<Text dimColor>No match.</Text>)

  return out
}

function entryEmpty(els: Els, m: Model, e: PrEntry | undefined): Node[] {
  const { Text } = els
  const isError = e?.status === 'error'
  // opened from Mine: its row is known, so name it while the full PR loads
  const row = m.mine.items.find(it => it.url === m.selected || String(it.number) === m.selected)
  const msg = !e || e.status === 'loading' || e.status === 'ok'
    ? row
      ? `Loading #${row.number} ${row.title}…`
      : 'Loading pull request…'
    : e.status === 'none'
      ? `No pull request ${m.selected === BRANCH ? `for ${m.track.branch || 'this branch'}` : m.selected}.`
      : `gh failed: ${clip(e.error, 400)}`

  return [
    <Text color={isError ? 'red' : undefined} dimColor={!isError} wrap="wrap">
      {msg}
    </Text>,
  ]
}

/** ` greptile 4/5 ` on the score's color. */
function greptileBadge(els: Els, L: Layout, g: GreptileScore): Node {
  const { Box, Text } = els
  const text = `${L.tier === 'tiny' ? 'G' : 'greptile'} ${g.score}/${g.of}`

  return (
    <Box flexShrink={0}>
      <Text backgroundColor={greptileColor(g)} color="black" bold>
        {` ${text} `}
      </Text>
    </Box>
  )
}

/** Short pane (inline above the prompt): one line per section, failures first. */
function compact(els: Els, L: Layout, pr: PrSnapshot): Node {
  const { Box, Text, Link } = els
  const isOpen = pr.state === 'OPEN'
  const badge = badgeOf(pr)
  const s = summaries(pr, isOpen)
  const failing = pr.checks.filter(c => c.state === 'fail').slice(0, 2)
  const last = pr.comments[pr.comments.length - 1]

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={0}>
          <Text color={badge.color} bold>
            {badge.label}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>#{pr.number}</Text>
        </Box>
        {pr.greptile && greptileBadge(els, L, pr.greptile)}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate">{pr.title}</Text>
        </Box>
      </Box>
      {/* stats as chips: they wrap instead of truncating on narrow panes */}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text>
          <Text dimColor>checks </Text>
          <Text color={s.checks.color}>{s.checks.text}</Text>
        </Text>
        {s.decision && <Text color={s.decision.color}>{s.decision.label}</Text>}
        <Text>
          <Text dimColor>threads </Text>
          <Text color={s.threads.color}>{s.threads.text}</Text>
        </Text>
        <Text dimColor>
          {pr.comments.length} comment{pr.comments.length === 1 ? '' : 's'}
        </Text>
      </Box>
      {failing.map(c => (
        <Text wrap="truncate">
          <Text color="red">✗ </Text>
          {c.url ? <Link href={c.url} label={c.name} /> : c.name}
        </Text>
      ))}
      {last && (
        <Text wrap="truncate" dimColor>
          @{last.author}: {preview(last.body, 1, L.cols)}
        </Text>
      )}
    </Box>
  )
}

export function drawPane(els: Els, L: Layout, m: Model, a: Actions): Node {
  const { Box } = els
  const tabs = tabBar(els, L, m, a)
  const gap = <Box marginTop={L.isCompact ? 0 : 1} />

  if (m.selected === MINE) {
    const status = m.mine.fetchedAt ? `${clockOf(m.mine.fetchedAt)} · ${m.tabs.length - 1} tracked` : 'loading'

    return frame(els, L, [tabs, gap, ...mineBody(els, L, m, a)], footerRows(els, L, m, mineKeys(els, m, a), status, m.mine.status === 'error'))
  }

  const e = m.entries[m.selected]
  const pr = e?.pr ?? null
  const where = m.selected === BRANCH ? m.track.branch || 'branch' : m.selected === m.track.peek ? 'preview · p pins it' : 'pinned'
  const status = `${e?.status === 'error' ? '⚠ gh failed · ' : ''}${e?.fetchedAt ? clockOf(e.fetchedAt) : 'loading'} · ${where}`
  const footer = footerRows(els, L, m, prKeys(L, m, pr, a), status, e?.status === 'error')
  if (!pr) return frame(els, L, [tabs, gap, ...entryEmpty(els, m, e)], footer)
  // an expanded inline pane asks for more rows (see register) and draws in full
  if (L.isCompact && !m.view.isExpanded) return frame(els, L, [tabs, compact(els, L, pr)], footer)

  return frame(els, L, [tabs, gap, ...detail(els, L, m, pr, a)], footer)
}

/** One PR in full: header, description, checks, reviews, threads, comments. */
function detail(els: Els, L: Layout, m: Model, pr: PrSnapshot, a: Actions): Node[] {
  const { Box, Text, Link, Button } = els
  const { view } = m
  const isOpen = pr.state === 'OPEN'
  const badge = badgeOf(pr)
  const s = summaries(pr, isOpen)
  const merge = isOpen ? MERGE[pr.mergeState] : undefined
  const isWide = L.tier === 'wide'
  const isTiny = L.tier === 'tiny'

  // checks: failing/running always; passing folded unless expanded
  const loud = pr.checks.filter(c => c.state === 'fail' || c.state === 'pending')
  const cap = isWide ? 6 : 3
  const shownChecks = isFull(m, 'Checks') ? pr.checks : loud.length ? loud : pr.checks.slice(0, cap)
  const hiddenChecks = pr.checks.length - shownChecks.length

  const threads = view.isResolvedShown ? pr.threads : pr.threads.filter(t => !t.isResolved)
  const comments = pr.comments.filter(c => !(view.isBotsHidden && c.isBot))
  const shownComments = isFull(m, 'Comments') ? comments : comments.slice(isWide ? -5 : -3)
  const workflowCols = Math.min(24, Math.floor(L.cols / 3))

  return [
    /*
     * header, one fact per line so nothing truncates: title, badges, number and
     * branches, size, merge state, labels, then the url once on its own line
     * (a Link with a label prints its url after it on terminals without hyperlinks)
     */
    <Text bold wrap="wrap">
      {pr.title}
    </Text>,
    <Box flexDirection="row" flexWrap="wrap" marginTop={1} columnGap={1}>
      <Box flexShrink={0}>
        <Text backgroundColor={badge.color} color="black" bold>
          {` ${badge.label} `}
        </Text>
      </Box>
      {pr.greptile && greptileBadge(els, L, pr.greptile)}
    </Box>,
    <Text wrap="wrap">
      <Text bold>#{pr.number}</Text>
      <Text dimColor>
        {' · '}
        {pr.head} → {pr.base}
      </Text>
    </Text>,
    <Text wrap="wrap">
      {!isTiny && <Text dimColor>@{pr.author} · </Text>}
      <Text color="green">+{pr.additions}</Text> <Text color="red">−{pr.deletions}</Text>
      <Text dimColor>
        {' '}
        · {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}
        {pr.updatedAt && !isTiny ? ` · ${ago(pr.updatedAt, m.now)}` : ''}
      </Text>
    </Text>,
    merge && (
      <Text color={merge.color} wrap="wrap">
        {merge.label}
      </Text>
    ),
    pr.labels.length > 0 && !isTiny && (
      <Text dimColor wrap="wrap">
        {pr.labels.map(l => `#${l}`).join(' ')}
      </Text>
    ),
    <Box>
      <Link href={pr.url} />
    </Box>,

    ...description(els, L, m, pr, a),

    section(els, L, m, a, 'Checks', s.checks.text, s.checks.color),
    ...(isClosed(m, 'Checks') ? [] : shownChecks).map(c => (
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text color={COLOR[c.state]}>{ICON[c.state]} </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate" dimColor={c.state === 'skip' || c.state === 'neutral'}>
            {c.url ? <Link href={c.url} label={c.name} /> : c.name}
            {c.count > 1 && <Text dimColor> ×{c.count}</Text>}
          </Text>
        </Box>
        {isWide && c.workflow && (
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{clip(c.workflow, workflowCols)}</Text>
          </Box>
        )}
        {isOpen && c.state === 'fail' && (
          <Box flexShrink={0} marginLeft={1}>
            <Button key={`fix-check:${c.workflow}/${c.name}`} plain label="fix" onPress={() => a.fixCheck(pr, c)} />
          </Box>
        )}
      </Box>
    )),
    !isClosed(m, 'Checks') &&
      (hiddenChecks > 0 || (view.fullSections ?? []).includes('Checks')) &&
      moreButton(els, m, a, 'Checks', `+${hiddenChecks} ${loud.length ? 'passing' : 'more'}`),

    section(
      els,
      L,
      m,
      a,
      'Reviews',
      s.decision?.[isTiny ? 'short' : 'label'] ?? (pr.reviewers.length ? `${pr.reviewers.length}` : 'none'),
      s.decision?.color,
    ),
    ...(isClosed(m, 'Reviews') ? [] : pr.reviewers).map(r => (
      <Box flexDirection="row">
        <Box flexShrink={0}>
          <Text color={REVIEW_COLOR[r.state] ?? 'gray'}>
            {r.state === 'APPROVED' ? '✓' : r.state === 'CHANGES_REQUESTED' ? '✗' : '○'}{' '}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate">@{r.login}</Text>
        </Box>
        {!isTiny && (
          <Box flexShrink={0} marginLeft={1}>
            <Text dimColor>{reviewVerb(r.state)}</Text>
          </Box>
        )}
      </Box>
    )),

    section(els, L, m, a, 'Threads', s.threads.text, s.threads.color),
    ...(isClosed(m, 'Threads') ? [] : threads).map((t, i) => threadCard(els, L, m, t, i === 0, a)),
    !isClosed(m, 'Threads') && threads.length > 0 && !view.isExpanded && moreButton(els, m, a, 'Threads', 'open all'),

    section(els, L, m, a, 'Comments', comments.length ? `${comments.length}` : 'none'),
    !isClosed(m, 'Comments') &&
      (comments.length > shownComments.length || (view.fullSections ?? []).includes('Comments')) &&
      moreButton(els, m, a, 'Comments', `${comments.length - shownComments.length} older`),
    ...(isClosed(m, 'Comments') ? [] : shownComments).map((c, i) => commentCard(els, L, m, c, i === 0, a)),
  ].filter(Boolean) as Node[]
}

