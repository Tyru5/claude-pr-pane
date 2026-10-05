export type CheckState = 'pass' | 'fail' | 'pending' | 'skip' | 'neutral'

export type PrCheck = {
  name: string
  workflow: string
  state: CheckState
  url: string
  /** identical runs folded into this row */
  count: number
}

export type PrComment = {
  id: string
  kind: 'comment' | 'review'
  author: string
  isBot: boolean
  body: string
  createdAt: string
  url: string
  reviewState: string
}

export type PrThreadComment = {
  author: string
  body: string
  createdAt: string
  url: string
}

export type PrThread = {
  id: string
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: PrThreadComment[]
}

export type PrReviewer = {
  login: string
  state: string
}

export type PrSnapshot = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  author: string
  head: string
  base: string
  mergeable: string
  mergeState: string
  reviewDecision: string
  additions: number
  deletions: number
  changedFiles: number
  updatedAt: string
  /** the PR description, markdown */
  body: string
  labels: string[]
  reviewers: PrReviewer[]
  checks: PrCheck[]
  comments: PrComment[]
  threads: PrThread[]
  /** Greptile's latest confidence score, when it reviewed this PR */
  greptile: GreptileScore | null
}

export type GreptileScore = {
  score: number
  of: number
  /** the summary comment it came from; the PR itself when greptile wrote it into the description */
  url: string
}

/** One tracked PR's fetch: the branch's PR (key `branch`) or a pin (key: its number or url). */
export type PrEntry = {
  status: 'loading' | 'ok' | 'none' | 'error'
  error: string
  fetchedAt: number
  pr: PrSnapshot | null
}

export type PrTrack = {
  isPaused: boolean
  /** pinned targets, in tab order: numbers (`42`) or urls */
  pins: string[]
  /** a PR opened from Mine, not yet pinned: one at a time, the next pick replaces it */
  peek: string
  /** the tab drawn: `mine`, `branch`, a pin or the peek */
  selected: string
  branch: string
}

/** One row of `gh pr list --author @me`. */
export type PrListItem = {
  number: number
  title: string
  url: string
  isDraft: boolean
  head: string
  updatedAt: string
  reviewDecision: string
  additions: number
  deletions: number
  fail: number
  pending: number
  pass: number
  greptile: GreptileScore | null
}

export type PrMine = {
  status: 'idle' | 'loading' | 'ok' | 'error'
  error: string
  fetchedAt: number
  items: PrListItem[]
}

export type MineFilter = 'all' | 'attention' | 'failing' | 'running' | 'review' | 'approved' | 'draft'

export type PrView = {
  isExpanded: boolean
  isBotsHidden: boolean
  isResolvedShown: boolean
  /** the footer's second row (view toggles) shown */
  isMoreKeys: boolean
  /** comment / thread ids opened one by one */
  openIds: string[]
  /** the Mine tab's search text and filter */
  query: string
  filter: MineFilter
  /** detail sections folded to their header */
  closedSections: PrSection[]
  /** detail sections drawn in full: every check, every comment, cards opened */
  fullSections: PrSection[]
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** The merge footer: idle, asking to confirm (with the repo's allowed methods), or running gh. */
export type PrMerge = {
  key: string
  status: 'idle' | 'confirm' | 'merging'
  methods: MergeMethod[]
  method: MergeMethod
}

export type PrSection = 'Description' | 'Checks' | 'Reviews' | 'Threads' | 'Comments'

declare module 'claude-code' {
  interface PluginState {
    'pr-pane': {
      entries: Record<string, PrEntry>
      track: PrTrack
      mine: PrMine
      prefs: PrView
      merge: PrMerge
    }
  }
}
