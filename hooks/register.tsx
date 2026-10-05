import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { MineFilter, PrEntry, PrListItem, PrMerge, PrMine, PrSnapshot, PrTrack, PrView } from '../types'
import {
  allowedMethods,
  checkCounts,
  diffSnapshots,
  fixPrompt,
  isConflicting,
  hostOf,
  isNoPr,
  mergeArgv,
  mergeMethodsArgv,
  mineArgv,
  mineScores,
  mineScoresArgv,
  normalize,
  normalizeList,
  normalizeThreads,
  parsePrUrl,
  pickMethod,
  REPO_ARGV,
  pinKey,
  prViewArgv,
  resolveConflictsPrompt,
  threadsArgv,
} from './gh'
import { BRANCH, MINE, drawPane, layoutFor, selectedOf, tabsOf } from './view'
import type { Actions, Model } from './view'

const PANE = 'pr'
const TITLE = 'PRs'
const COMMAND = 'pr-pane'
const POLL_PENDING_MS = 15_000
const POLL_IDLE_MS = 45_000
const POLL_SLOW_MS = 90_000
const MINE_STALE_MS = 120_000

const entriesAtom = atom({ plugin: 'pr-pane', key: 'entries' } as const, {} as Record<string, PrEntry>)
const trackAtom = atom({ plugin: 'pr-pane', key: 'track' } as const, {
  isPaused: false,
  pins: [],
  peek: '',
  selected: '',
  branch: '',
} as PrTrack)
const mineAtom = atom({ plugin: 'pr-pane', key: 'mine' } as const, {
  status: 'idle',
  error: '',
  fetchedAt: 0,
  items: [],
} as PrMine)
const viewAtom = atom({ plugin: 'pr-pane', key: 'prefs' } as const, {
  isExpanded: false,
  isBotsHidden: false,
  isResolvedShown: false,
  isMoreKeys: false,
  openIds: [],
  query: '',
  filter: 'all',
  closedSections: [],
  fullSections: [],
} as PrView)

const mergeAtom = atom({ plugin: 'pr-pane', key: 'merge' } as const, {
  key: '',
  status: 'idle',
  methods: [],
  method: 'merge',
} as PrMerge)

const IDLE_MERGE: PrMerge = { key: '', status: 'idle', methods: [], method: 'merge' }

/** `m`: conflicts go to Claude with T3 Code's prompt; otherwise ask to confirm, offering the repo's methods. */
async function startMerge($: EngineInterface, key: string, pr: PrSnapshot, branch: string) {
  if (isConflicting(pr)) {
    await $.prompt.submit({ text: resolveConflictsPrompt(pr, branch !== '' && branch === pr.head) })
    $.ui.toast(`PR #${pr.number}: conflicts handed to Claude`, { timeoutMs: 4_000 })

    return
  }
  const ref = parsePrUrl(pr.url)
  let methods = allowedMethods({ mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true })
  if (ref) {
    const run = await $.process.run(mergeMethodsArgv(ref), { timeoutMs: 15_000 })
    if (run.exitCode === 0) {
      const allowed = allowedMethods(JSON.parse(run.stdout))
      if (allowed.length) methods = allowed
    }
  }
  await update($, mergeAtom, () => ({ key, status: 'confirm' as const, methods, method: pickMethod(methods) }))
}

/** `gh pr view --web`: gh opens the person's browser ($BROWSER, gh's `browser` config, or the OS default). */
async function openWeb($: EngineInterface, pr: PrSnapshot) {
  const run = await $.process.run(['gh', 'pr', 'view', pr.url, '--web'], { timeoutMs: 15_000 })
  if (run.exitCode === 0) $.ui.toast(`Opened PR #${pr.number} in the browser`, { timeoutMs: 3_000 })
  else $.ui.toast(`Could not open #${pr.number}: ${(run.stderr.trim() || `gh exited ${run.exitCode}`).split('\n')[0]}`, { timeoutMs: 6_000 })
}

async function confirmMerge($: EngineInterface, pr: PrSnapshot) {
  const m = await read($, mergeAtom)
  if (m.status !== 'confirm') return
  await update($, mergeAtom, v => ({ ...v, status: 'merging' as const }))
  const run = await $.process.run(mergeArgv(pr, m.method), { timeoutMs: 60_000 })
  await update($, mergeAtom, () => IDLE_MERGE)
  if (run.exitCode === 0) {
    $.ui.toast(`Merged PR #${pr.number} (${m.method})`, { timeoutMs: 5_000 })
  } else {
    const err = (run.stderr.trim() || run.stdout.trim() || `gh exited ${run.exitCode}`).split('\n')[0] ?? ''
    $.ui.toast(`Merge of #${pr.number} failed: ${err}`, { timeoutMs: 8_000 })
  }
  void refresh($)
}

function statusLine(pr: PrSnapshot): string {
  const n = checkCounts(pr.checks)
  const open = pr.threads.filter(t => !t.isResolved).length
  const parts = [`PR #${pr.number}`]
  const checks = [n.pass && `${n.pass}✓`, n.fail && `${n.fail}✗`, n.pending && `${n.pending}●`].filter(Boolean)
  if (checks.length) parts.push(checks.join(' '))
  if (open) parts.push(`${open} open thread${open === 1 ? '' : 's'}`)
  if (pr.greptile) parts.push(`greptile ${pr.greptile.score}/${pr.greptile.of}`)

  return parts.join(' · ')
}

// module vars reset on reload; the old env's timers are dropped with it
let timer: Timer | undefined
let isTimerSet = false
let isFetching = false
// keys being fetched now: the poll and a pick never fetch one twice at once
const inFlight = new Set<string>()
// the pane holds the keyboard: only then can the ring be moved
let isPaneFocused = false
// bumped on each search submit (see Model.searchKey)
let searchGen = 0
const searchKey = () => (searchGen ? `search-${searchGen}` : 'search')
// terminal width last seen, and the dock width last asked for it
let termColumns = 0
let askedColumns = 0

/** Dock width for a terminal: ~38% of it, so the transcript keeps the larger share. */
function paneColumns(term: number): number {
  return Math.max(34, Math.min(72, Math.floor(term * 0.38)))
}

/** Opens the pane, asking a dock width that suits the terminal. */
function seat($: EngineInterface) {
  askedColumns = termColumns ? paneColumns(termColumns) : 0
  return $.ui.open({ id: PANE, title: TITLE, ...(askedColumns ? { columns: askedColumns } : {}) })
}

function patchEntry($: EngineInterface, key: string, patch: Partial<PrEntry>) {
  return update($, entriesAtom, all => {
    const was: PrEntry = all[key] ?? { status: 'loading', error: '', fetchedAt: 0, pr: null }
    return { ...all, [key]: { ...was, ...patch } }
  })
}

function schedule($: EngineInterface, ms: number) {
  timer?.cancel()
  isTimerSet = true
  timer = $.clock.after(ms, () => {
    isTimerSet = false
    void refresh($)
  })
}

function stopTimer() {
  timer?.cancel()
  isTimerSet = false
}

/** One PR's poll: the delay it asks for, how many changes it saw, whether gh failed. */
type Fetched = { ms: number; changes: number; isFailed: boolean }

/** Fetches one tracked PR; one already being fetched is left to that fetch. */
async function fetchEntry($: EngineInterface, key: string, target: string, now: number): Promise<Fetched> {
  if (inFlight.has(key)) return { ms: POLL_IDLE_MS, changes: 0, isFailed: false }
  inFlight.add(key)
  try {
    return await fetchEntryOnce($, key, target, now)
  } finally {
    inFlight.delete(key)
  }
}

async function fetchEntryOnce($: EngineInterface, key: string, target: string, now: number): Promise<Fetched> {
  const prev = (await read($, entriesAtom))[key]
  if (!prev?.fetchedAt) await patchEntry($, key, { status: 'loading' })

  const view = await $.process.run(prViewArgv(target), { timeoutMs: 20_000 })
  if (view.exitCode !== 0) {
    const err = view.stderr.trim() || `gh exited ${view.exitCode}`
    const isNone = isNoPr(err)
    await patchEntry($, key, { status: isNone ? 'none' : 'error', error: err, fetchedAt: now, ...(isNone ? { pr: null } : {}) })

    return { ms: POLL_SLOW_MS, changes: 0, isFailed: !isNone }
  }

  const raw = JSON.parse(view.stdout)
  const was = prev?.pr ?? null
  const ref = parsePrUrl(String(raw.url ?? ''))
  let threads = was && was.number === Number(raw.number) ? was.threads : []
  if (ref) {
    const t = await $.process.run(threadsArgv(ref), { timeoutMs: 20_000 })
    if (t.exitCode === 0) threads = normalizeThreads(JSON.parse(t.stdout))
  }

  const snap = normalize(raw, threads)
  const changes = diffSnapshots(was, snap)
  await patchEntry($, key, { status: 'ok', error: '', fetchedAt: now, pr: snap })

  if (changes.length) {
    const more = changes.length > 3 ? ` (+${changes.length - 3})` : ''
    $.ui.toast(`PR #${snap.number}: ${changes.slice(0, 3).join(' · ')}${more}`, { timeoutMs: 6_000 })
  }
  // first sighting of the branch's PR this session: seat the pane (unasked, so only when wide)
  if (key === BRANCH && !was) seat($).catch(() => undefined)

  const ms = snap.state !== 'OPEN' ? POLL_SLOW_MS : checkCounts(snap.checks).pending > 0 ? POLL_PENDING_MS : POLL_IDLE_MS

  return { ms, changes: changes.length, isFailed: false }
}

let isMineFetching = false
// `owner/name` and host of the cwd's repo, looked up once per module load
let repo: { name: string; host: string } | null = null

/**
 * The Mine list, its own fetch (never queued behind the PR polls): the list
 * first, drawn as soon as it lands, then greptile scores in a second pass.
 */
async function fetchMine($: EngineInterface): Promise<void> {
  if (isMineFetching) return
  isMineFetching = true
  const fail = async (error: string) => {
    const now = await $.clock.now()
    await update($, mineAtom, m => ({ ...m, status: 'error' as const, error, fetchedAt: now }))
  }
  try {
    const mine = await read($, mineAtom)
    if (!mine.fetchedAt || mine.status === 'error') await update($, mineAtom, m => ({ ...m, status: 'loading' as const }))
    if (!repo) {
      const r = await $.process.run(REPO_ARGV, { timeoutMs: 15_000 })
      if (r.exitCode !== 0) return void (await fail(r.stderr.trim() || `gh repo view exited ${r.exitCode}`))
      const j = JSON.parse(r.stdout)
      repo = { name: String(j.nameWithOwner ?? ''), host: hostOf(String(j.url ?? '')) }
    }
    const { name, host } = repo

    const run = await $.process.run(mineArgv(name, host), { timeoutMs: 30_000 })
    if (run.exitCode !== 0) return void (await fail(run.stderr.trim() || `gh exited ${run.exitCode}`))
    // keep the scores already known until the second pass replaces them
    const known = new Map((await read($, mineAtom)).items.map(it => [it.number, it.greptile]))
    const items = normalizeList(JSON.parse(run.stdout)).map(it => ({ ...it, greptile: known.get(it.number) ?? null }))
    const now = await $.clock.now()
    await update($, mineAtom, () => ({ status: 'ok' as const, error: '', fetchedAt: now, items }))

    const scores = await $.process.run(mineScoresArgv(name, host), { timeoutMs: 30_000 })
    if (scores.exitCode !== 0 || scores.isStdoutTruncated) return
    const byNumber = mineScores(JSON.parse(scores.stdout))
    await update($, mineAtom, m => ({
      ...m,
      items: m.items.map(it => (byNumber.has(it.number) ? { ...it, greptile: byNumber.get(it.number) ?? null } : it)),
    }))
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err))
  } finally {
    isMineFetching = false
  }
}

/** Polls every tracked PR (branch first, then pins) and, when due, the Mine list. */
async function refresh($: EngineInterface, opts: { isMineDue?: boolean; isManual?: boolean } = {}): Promise<void> {
  if (isFetching) {
    if (opts.isManual) $.ui.toast('PR refresh already running…', { timeoutMs: 3_000 })

    return
  }
  isFetching = true
  // what a refresh the person asked for reports when it lands
  let changed = 0
  let failed = 0
  let nextMs = POLL_SLOW_MS
  // nothing to poll (no repo, no pins): leave the timer off until asked again
  let isIdle = false
  try {
    const track = await read($, trackAtom)
    if (track.isPaused) {
      stopTimer()

      return
    }

    const git = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5_000 })
    const isRepo = git.exitCode === 0
    const branch = isRepo ? git.stdout.trim() : ''
    if (branch !== track.branch) await update($, trackAtom, t => ({ ...t, branch }))
    const now = await $.clock.now()

    // outside a repo only pins / the peek (urls) and an explicit Mine ask are worth a gh call
    const mine = await read($, mineAtom)
    const isMineDue = opts.isMineDue || track.selected === MINE || (isRepo && now - mine.fetchedAt > MINE_STALE_MS)
    const peek = track.peek && !track.pins.includes(track.peek) ? [[track.peek, track.peek]] : []
    const targets = [...(isRepo ? [[BRANCH, '']] : []), ...track.pins.map(p => [p, p]), ...peek] as [string, string][]
    if (!targets.length && !isMineDue) {
      isIdle = true
      stopTimer()
      if (opts.isManual) $.ui.toast('Not in a git repo: pin a PR url to track it', { timeoutMs: 4_000 })

      return
    }

    // the list runs beside the PR polls, so the Mine tab never waits on them
    const mineDone = isMineDue ? fetchMine($) : Promise.resolve()

    for (const [key, target] of targets) {
      try {
        const got = await fetchEntry($, key, target, now)
        nextMs = Math.min(nextMs, got.ms)
        changed += got.changes
        if (got.isFailed) failed += 1
      } catch (err) {
        failed += 1
        await patchEntry($, key, { status: 'error', error: err instanceof Error ? err.message : String(err), fetchedAt: now })
      }
    }

    await mineDone

    await showStatus($)
    if (opts.isManual) {
      const entries = await read($, entriesAtom)
      const prs = Object.values(entries).filter(en => en.pr).length
      const isMine = (await read($, mineAtom)).status === 'ok' && (opts.isMineDue || track.selected === MINE)
      const parts = [`↻ Refreshed ${prs} PR${prs === 1 ? '' : 's'}${isMine ? ' + your list' : ''}`]
      parts.push(changed ? `${changed} change${changed === 1 ? '' : 's'}` : 'no changes')
      if (failed) parts.push(`${failed} failed`)
      $.ui.toast(parts.join(' · '), { timeoutMs: 4_000 })
    }
  } finally {
    isFetching = false
    const track = await read($, trackAtom)
    if (!track.isPaused && !isIdle) schedule($, nextMs)
  }
}

/**
 * Status line, one line for every tracked PR: the drawn one (else the branch's)
 * in full, the others as number, check glyph and greptile score, in tab order.
 * `PR #83 · 4✓ 1● · greptile 5/5 │ #57 ✗ 3/5 │ #60 ✓`
 */
async function showStatus($: EngineInterface) {
  const entries = await read($, entriesAtom)
  const track = await read($, trackAtom)
  const tabs = tabsOf(entries, track).filter(t => t.key !== MINE && entries[t.key]?.pr)
  const lead = tabs.find(t => t.key === track.selected) ?? tabs.find(t => t.key === BRANCH) ?? tabs[0]
  if (!lead) return void $.ui.status(undefined)

  const rest = tabs.filter(t => t !== lead)
  const shown = rest.slice(0, 4).map(t => {
    const pr = entries[t.key]?.pr
    const score = pr?.greptile ? ` ${pr.greptile.score}/${pr.greptile.of}` : ''
    return `#${pr?.number ?? t.key} ${t.glyph}${score}`
  })
  const more = rest.length > shown.length ? [`+${rest.length - shown.length}`] : []
  const leadPr = entries[lead.key]?.pr
  $.ui.status(leadPr ? [statusLine(leadPr), ...shown, ...more].join(' │ ') : undefined)
}

/** Moves the ring to one of the pane's elements; only the person can give the pane the keyboard. */
function focusKey($: EngineInterface, key: string) {
  if (!isPaneFocused) return
  $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

/**
 * Draws a tab. The ring follows: onto the tab itself (so a PR opens at its top,
 * not wherever the old ring index lands), or back on Mine, onto the row of the
 * PR just left, so the list keeps the place.
 */
async function select($: EngineInterface, key: string) {
  const was = await read($, trackAtom)
  const entries = await read($, entriesAtom)
  const drawn = selectedOf(tabsOf(entries, was), was.selected)
  await update($, trackAtom, t => ({ ...t, selected: key }))
  await showStatus($)
  const mine = await read($, mineAtom)
  if (key === MINE) {
    const left = entries[drawn]?.pr
    const row = left && mine.items.find(it => it.url === left.url)
    focusKey($, row ? `mine:${row.number}` : `tab:${MINE}`)
  } else {
    focusKey($, `tab:${key}`)
  }
  if (key === MINE && (mine.status !== 'ok' || (await $.clock.now()) - mine.fetchedAt > MINE_STALE_MS)) void fetchMine($)
}

/** Fetches one PR now, outside the poll (which may be mid-run), and keeps the poll going. */
async function loadNow($: EngineInterface, key: string) {
  const now = await $.clock.now()
  try {
    const got = await fetchEntry($, key, key, now)
    if (!isTimerSet && !isFetching) schedule($, got.ms)
  } catch (err) {
    await patchEntry($, key, { status: 'error', error: err instanceof Error ? err.message : String(err), fetchedAt: now })
  }
  await showStatus($)
}

/** Drops a fetched PR no tab shows any more. */
function forget($: EngineInterface, key: string) {
  return update($, entriesAtom, all => {
    const { [key]: _gone, ...rest } = all
    return rest
  })
}

/** Adds pins (deduped), draws the last one and fetches the new ones. */
async function pin($: EngineInterface, keys: string[]) {
  if (!keys.length) return
  const was = await read($, trackAtom)
  const added = keys.filter(k => !was.pins.includes(k))
  await update($, trackAtom, t => ({
    ...t,
    isPaused: false,
    pins: [...t.pins, ...added],
    peek: added.includes(t.peek) ? '' : t.peek,
    selected: keys[keys.length - 1] ?? t.selected,
  }))
  void (async () => {
    for (const k of added) await loadNow($, k)
  })()
}

/**
 * A Mine row: its tab when one shows it already, else it opens as the peek,
 * the one unpinned tab, which the next pick replaces (`p` keeps it).
 */
async function pick($: EngineInterface, item: PrListItem) {
  const entries = await read($, entriesAtom)
  const track = await read($, trackAtom)
  const hit = tabsOf(entries, track).find(
    t => t.key !== MINE && (t.key === item.url || t.key === String(item.number) || entries[t.key]?.pr?.url === item.url),
  )
  if (hit) return select($, hit.key)

  const old = track.peek ?? ''
  await update($, trackAtom, t => ({ ...t, isPaused: false, peek: item.url, selected: item.url }))
  if (old && !track.pins.includes(old)) await forget($, old)
  focusKey($, `tab:${item.url}`)
  await loadNow($, item.url)
}

async function pinPeek($: EngineInterface) {
  const track = await read($, trackAtom)
  if (!track.peek) return
  const pr = (await read($, entriesAtom))[track.peek]?.pr
  await update($, trackAtom, t => ({ ...t, pins: t.pins.includes(t.peek) ? t.pins : [...t.pins, t.peek], peek: '' }))
  $.ui.toast(`Pinned ${pr ? `#${pr.number}` : track.peek}`, { timeoutMs: 3_000 })
  await showStatus($)
}

async function unpin($: EngineInterface, key: string) {
  const was = await read($, trackAtom)
  const url = (await read($, entriesAtom))[key]?.pr?.url ?? key
  await update($, trackAtom, t => ({
    ...t,
    pins: t.pins.filter(p => p !== key),
    peek: t.peek === key ? '' : t.peek,
    // a closed peek goes back to the list it came from
    selected: t.selected !== key ? t.selected : t.peek === key ? MINE : '',
  }))
  await forget($, key)
  await showStatus($)
  if (was.peek === key && was.selected === key) {
    const row = (await read($, mineAtom)).items.find(it => it.url === url)
    focusKey($, row ? `mine:${row.number}` : `tab:${MINE}`)
  }
}

/** Enter in the search: one hit opens; several put the ring on the first, so the arrows walk the hits. */
async function submitSearch($: EngineInterface, query: string, hits: PrListItem[]) {
  searchGen += 1
  await update($, viewAtom, v => ({ ...v, query }))
  // the query may be unchanged (onInput set it): redraw for the new key anyway
  $.ui.invalidate('ui.render')
  const [first] = hits
  if (!first) return focusKey($, searchKey())
  if (hits.length === 1) await pick($, first)
  else focusKey($, `mine:${first.number}`)
}

async function reseat($: EngineInterface) {
  await seat($).catch(() => undefined)
}

async function resize($: EngineInterface, rows: number) {
  await $.ui.open({ id: PANE, title: TITLE, rows }).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // a merge left asking (or mid-run) by a reload starts over
    await update($, mergeAtom, () => IDLE_MERGE)
    try {
      await $.command.register({
        name: COMMAND,
        description: 'GitHub PR pane: numbers/urls pin tabs | rm <n> | mine | branch | refresh | off',
        argumentHint: '[<n|url>... | add <n> | rm <n> | mine | branch | refresh | off]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`pr-pane: /${COMMAND} not registered: ${String(err)}`, { to: 'debug' })
    }
    void refresh($)

    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const [verb = '', ...rest] = words

    if (verb === 'off' || verb === 'stop') {
      stopTimer()
      await update($, trackAtom, t => ({ ...t, isPaused: true }))
      $.ui.status(undefined)
      await $.ui.close({ id: PANE })

      return { text: `PR pane off. /${COMMAND} to resume.` }
    }

    termColumns = e.presentation.columns
    let text = 'PR pane open.'
    if (verb === 'rm' || verb === 'unpin') {
      const keys = rest.map(pinKey).filter(Boolean)
      for (const k of keys) await unpin($, k)
      text = keys.length ? `Unpinned ${keys.map(k => `#${k}`).join(' ')}.` : `Usage: /${COMMAND} rm <number|url>`
    } else if (verb === 'mine' || verb === 'branch') {
      await select($, verb === 'mine' ? MINE : BRANCH)
      text = verb === 'mine' ? 'Showing your open PRs.' : 'Showing the current branch PR.'
    } else if (verb !== '' && verb !== 'refresh') {
      const keys = (verb === 'add' || verb === 'pin' ? rest : words).map(pinKey).filter(Boolean)
      if (!keys.length) return { text: `Not a PR number or url: ${e.args.trim()}` }
      await pin($, keys)
      text = `Tracking ${keys.map(k => (/^\d+$/.test(k) ? `#${k}` : k)).join(' ')}.`
    }

    await update($, trackAtom, t => ({ ...t, isPaused: false }))
    await seat($)
    void refresh($, { isMineDue: verb === 'refresh' || verb === 'mine', isManual: verb === 'refresh' })

    return { text }
  })

  // the model pushed or touched a PR: poll soon instead of waiting
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\s+push\b|\bgh\s+pr\s+(create|ready|merge|edit|review|comment|close|reopen)\b/.test(e.command)) {
      const track = await read($, trackAtom)
      if (!track.isPaused) schedule($, 4_000)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    isPaneFocused = e.props.isFocused
    // terminal resized: ask the dock for a width that fits it (a width the person dragged still wins)
    const term = e.viewport?.columns ?? 0
    if (term && e.props.placement === 'dock' && paneColumns(term) !== askedColumns) {
      termColumns = term
      askedColumns = paneColumns(term)
      $.clock.after(0, () => void reseat($))
    }
    const L = layoutFor(e.props.bodyColumns, e.props.scroll.bodyRows, e.props.isFocused, {
      offset: e.props.scroll.offset,
      isTerminal: e.surface === 'terminal',
    })
    const entries = await read($, entriesAtom)
    const track = await read($, trackAtom)
    const tabs = tabsOf(entries, track)
    const model: Model = {
      entries,
      track,
      mine: await read($, mineAtom),
      view: await read($, viewAtom),
      merge: await read($, mergeAtom),
      now: await $.clock.now(),
      command: COMMAND,
      tabs,
      selected: selectedOf(tabs, track.selected),
      searchKey: searchKey(),
    }
    const actions: Actions = {
      refresh: () => void refresh($, { isMineDue: model.selected === MINE, isManual: true }),
      toggleView: key => {
        void update($, viewAtom, v => ({ ...v, [key]: !v[key] }))
        // inline above the prompt: expanding asks for room, collapsing gives it back
        if (key === 'isExpanded' && e.props.placement === 'inline') {
          const isGrowing = !model.view.isExpanded
          const rows = isGrowing ? Math.max(14, Math.floor((e.viewport?.rows ?? 40) * 0.6)) : 8
          void resize($, rows)
        }
      },
      toggleOpen: id =>
        void update($, viewAtom, v => {
          const open = v.openIds ?? []
          return { ...v, openIds: open.includes(id) ? open.filter(x => x !== id) : [...open, id].slice(-100) }
        }),
      toggleSection: (name, list) =>
        void update($, viewAtom, v => {
          const names = v[list] ?? []
          return { ...v, [list]: names.includes(name) ? names.filter(x => x !== name) : [...names, name] }
        }),
      openWeb: pr => void openWeb($, pr),
      merge: pr => void startMerge($, model.selected, pr, track.branch).catch(err => $.ui.toast(`Merge failed: ${String(err)}`)),
      confirmMerge: pr => void confirmMerge($, pr),
      cycleMethod: () =>
        void update($, mergeAtom, v => ({ ...v, method: v.methods[(v.methods.indexOf(v.method) + 1) % v.methods.length] ?? v.method })),
      cancelMerge: () => void update($, mergeAtom, () => IDLE_MERGE),
      openSections: () => void update($, viewAtom, v => ({ ...v, closedSections: [] })),
      close: () => void $.ui.close({ id: PANE }).catch(() => undefined),
      fix: pr => {
        void $.prompt.fill({ text: fixPrompt(pr), mode: 'replace' })
        $.ui.toast('Fix prompt placed in the composer')
      },
      select: key => void select($, key),
      unpin: key => void unpin($, key),
      pick: item => void pick($, item),
      pinPeek: () => void pinPeek($),
      setQuery: query => void update($, viewAtom, v => ({ ...v, query })),
      submitSearch: (query, hits) => void submitSearch($, query, hits),
      focusSearch: () => focusKey($, searchKey()),
      setFilter: (filter: MineFilter) => void update($, viewAtom, v => ({ ...v, filter })),
    }

    return drawPane(els, L, model, actions)
  })
}
