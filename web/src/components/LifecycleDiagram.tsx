import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * The whole launchpad lifecycle, drawn — three actors and the money between them.
 *
 * ── Why a drawing and not the four cards ─────────────────────────────────────
 * The cards under this diagram say what each stage *is*. What they cannot say is
 * who does what to whom: that the creator never touches the pool, that the buy
 * which reaches the target is the same transaction that creates and locks the
 * pool, that the fee leaves the curve in two directions at once, and that one
 * arrow — the LP NFT into the locker — has no return edge. Those are relations,
 * and prose states relations badly. Drawn as lanes, the shape is the argument.
 *
 * ── Two drawings, one meaning ────────────────────────────────────────────────
 * A swimlane diagram needs width. The wide version's labels are 11 units against
 * a 1120-unit box, so they only clear 12px once the column is about 1230px wide
 * — which is `xl`, and why the breakpoint is not the `lg` it looks like it should
 * be. Everything below gets the same flow as one vertical column, capped near a
 * phone's width so it does not balloon on a tablet. Both are `role="img"` with
 * the same accessible name, and `display: none` keeps the hidden one out of the
 * accessibility tree, so a screen reader is never offered both.
 *
 * The `sr-only` ordered list below them is not a caption — it is the diagram in
 * words, because a picture is the one format a reader can be unable to open.
 *
 * ── Colour ──────────────────────────────────────────────────────────────────
 * Every fill and stroke is a design token read straight off the CSS variable,
 * never a literal, so the drawing follows the theme the way the rest of the page
 * does. The accent carries exactly two meanings and no decoration: a primary
 * stroke is value moving (USDG in, tokens out, the fee split, pool fees), and
 * primary text marks the two things that cannot be undone. Sequence — this then
 * that — is muted. Nothing else is coloured.
 */

/* ── Tokens ─────────────────────────────────────────────────────────────────
   Written as `hsl(var(--x))` rather than Tailwind's `fill-card` so the SVG can
   be read as a drawing without a second file to resolve the palette. */
const CARD = 'hsl(var(--card))'
const BORDER = 'hsl(var(--border))'
const FG = 'hsl(var(--foreground))'
const MUTED = 'hsl(var(--muted-foreground))'
const PRIMARY = 'hsl(var(--primary))'

/**
 * The figures the diagram prints, already formatted by the page that owns them.
 * The Learn page reads them from the factory when it is live and falls back to
 * the deploy defaults, and the diagram must not be a third opinion — so it is
 * handed strings and formats nothing.
 */
export type LifecycleFigures = {
  /** "1 USDG" — paid once, at launch. */
  creationFee: string
  /** "5" — dev-buy cap, percent of supply. */
  devBuyMax: string
  /** 3 — blocks the anti-snipe window covers. */
  snipeBlocks: number
  /** "1" — per-address anti-snipe cap, percent of supply. */
  snipeMax: string
  /** "1" — curve trade fee, percent. */
  tradeFee: string
  /** "70" / "30" — how that fee splits. */
  creatorShare: string
  hoodiumShare: string
  /** "69,000 USDG". */
  target: string
  /** "200M" — tokens held back for the pool. */
  lpAllocation: string
  /** "70" / "30" — how locked-pool swap fees split. */
  lpCreatorShare: string
  lpProtocolShare: string
  /** "USDG". */
  quoteSymbol: string
}

const ACCESSIBLE_NAME =
  'Lifecycle of a token on Hoodium Launchpad: the creator launches it through the factory, buyers and ' +
  'sellers trade it against the bonding curve, and the buy that reaches the target closes the curve and ' +
  'seeds a Uniswap v3 pool whose LP NFT is locked forever.'

/* ── Primitives ────────────────────────────────────────────────────────────── */

type BoxProps = {
  x: number
  y: number
  w: number
  h: number
  /** Omitted for a plain note — a box that is only body lines. */
  title?: string
  /** Set for a contract call or an amount; the page sets every figure in mono. */
  titleMono?: boolean
  lines?: string[]
  /** A closing line in the accent, for the two irreversible steps. */
  note?: string
  /** Secondary matter — the rare branch, the terms footnote. */
  dashed?: boolean
  /** Body size, where a line is one character too long for the default 11. */
  bodySize?: number
  /** Draws the padlock in the title row: this step cannot be undone. */
  lock?: boolean
  pad?: number
}

function Box({
  x,
  y,
  w,
  h,
  title,
  titleMono = false,
  lines = [],
  note,
  dashed = false,
  bodySize = 11,
  lock = false,
  pad = 12,
}: BoxProps) {
  const bodyTop = title ? y + 40 : y + 20
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        fill={dashed ? 'none' : CARD}
        stroke={BORDER}
        strokeWidth={1}
        strokeDasharray={dashed ? '3 4' : undefined}
      />
      {title && (
        <text
          x={x + pad}
          y={y + 22}
          fill={FG}
          fontSize={titleMono ? 11.5 : 12.5}
          fontWeight={500}
          className={titleMono ? 'font-mono' : 'font-sans'}
        >
          {title}
        </text>
      )}
      {lock && <Lock x={x + w - pad - 9} y={y + 11} />}
      {lines.map((line, i) => (
        <text
          key={`${line}-${i}`}
          x={x + pad}
          y={bodyTop + i * (bodySize + 4)}
          fill={MUTED}
          fontSize={bodySize}
          className="font-mono"
        >
          {line}
        </text>
      ))}
      {note && (
        <text
          x={x + pad}
          y={bodyTop + lines.length * (bodySize + 4) + 3}
          fill={PRIMARY}
          fontSize={bodySize - 0.5}
          className="font-mono"
        >
          {note}
        </text>
      )}
    </g>
  )
}

/** One mono line in a pill — a call, an approval, a share. */
function Chip({ x, y, w, h, text, mono = true }: { x: number; y: number; w: number; h: number; text: string; mono?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={7} fill={CARD} stroke={BORDER} strokeWidth={1} />
      <text
        x={x + w / 2}
        y={y + h / 2 + 4}
        textAnchor="middle"
        fill={FG}
        fontSize={11}
        className={mono ? 'font-mono' : 'font-sans'}
      >
        {text}
      </text>
    </g>
  )
}

/**
 * The padlock. Drawn rather than imported because it has to sit at 9px inside a
 * title row and every icon set's shackle disappears at that size.
 */
function Lock({ x, y }: { x: number; y: number }) {
  return (
    <g stroke={PRIMARY} strokeWidth={1.1} fill="none">
      <path d={`M${x + 1.6} ${y + 4} v-1.4 a2.4 2.4 0 0 1 4.8 0 v1.4`} strokeLinecap="round" />
      <rect x={x} y={y + 4} width={8} height={5.6} rx={1.4} />
    </g>
  )
}

/** A sequence edge (muted) or a value edge (accent). */
function Edge({
  d,
  money = false,
  dashed = false,
  marker,
}: {
  d: string
  money?: boolean
  dashed?: boolean
  /** Omitted for a stub that runs into another edge's trunk. */
  marker?: string
}) {
  return (
    <path
      d={d}
      fill="none"
      stroke={money ? PRIMARY : MUTED}
      strokeWidth={1.25}
      strokeDasharray={dashed ? '3 4' : undefined}
      strokeLinecap="round"
      strokeLinejoin="round"
      markerEnd={marker ? `url(#${marker})` : undefined}
    />
  )
}

/** A label on an edge. */
function EdgeLabel({
  x,
  y,
  children,
  money = false,
  anchor = 'start',
  size = 10,
}: {
  x: number
  y: number
  children: string
  money?: boolean
  anchor?: 'start' | 'middle' | 'end'
  size?: number
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} fill={money ? PRIMARY : MUTED} fontSize={size} className="font-mono">
      {children}
    </text>
  )
}

function Markers({ seq, money }: { seq: string; money: string }) {
  return (
    <defs>
      <marker id={seq} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
        <path d="M0 0 L8 4 L0 8 z" fill={MUTED} />
      </marker>
      <marker id={money} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
        <path d="M0 0 L8 4 L0 8 z" fill={PRIMARY} />
      </marker>
    </defs>
  )
}

/* ── The wide drawing: three lanes, four stages ─────────────────────────────── */

/** Stage columns. Widths are set by the longest line each stage has to carry. */
const S1 = 104
const S2 = 360
const S3 = 632
const S4 = 926
const RIGHT = 1112

/** Lane baselines. */
const CREATOR_Y = 44
const BUYER_Y = 196
const CONTRACT_Y = 344

function StageHeader({ x, label }: { x: number; label: string }) {
  return (
    <g>
      <text x={x} y={24} fill={MUTED} fontSize={10.5} letterSpacing={1.6} className="font-mono">
        {label.toUpperCase()}
      </text>
      <line x1={x} y1={33} x2={x + 26} y2={33} stroke={PRIMARY} strokeWidth={1.5} strokeLinecap="round" />
    </g>
  )
}

function LaneLabel({ y, lines }: { y: number; lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <text
          key={line}
          x={88}
          y={y + i * 12}
          textAnchor="end"
          fill={MUTED}
          fontSize={9.5}
          letterSpacing={1.2}
          className="font-mono"
        >
          {line}
        </text>
      ))}
    </>
  )
}

function WideDiagram({ f, uid, className }: { f: LifecycleFigures; uid: string; className?: string }) {
  const q = f.quoteSymbol
  const seq = `${uid}-wide-seq`
  const money = `${uid}-wide-money`
  return (
    <svg
      viewBox="0 0 1120 620"
      className={cn('h-auto w-full max-w-full', className)}
      role="img"
      aria-label={ACCESSIBLE_NAME}
      focusable="false"
    >
      <title>How a token moves through Hoodium Launchpad</title>
      <desc>{ACCESSIBLE_NAME}</desc>
      <Markers seq={seq} money={money} />

      {/* Stage columns and the two lane rules. Dashed and thin: scaffolding the
          eye should be able to ignore once it has found the lanes. */}
      {[354, 626, 913].map((x) => (
        <line key={x} x1={x} y1={12} x2={x} y2={560} stroke={BORDER} strokeWidth={1} strokeDasharray="2 6" />
      ))}
      {[186, 334].map((y) => (
        <line key={y} x1={0} y1={y} x2={RIGHT} y2={y} stroke={BORDER} strokeWidth={1} strokeDasharray="2 6" />
      ))}

      <StageHeader x={S1} label="Launch" />
      <StageHeader x={S2} label="Curve" />
      <StageHeader x={S3} label="Graduation" />
      <StageHeader x={S4} label="Locked pool" />

      <LaneLabel y={CREATOR_Y + 68} lines={['CREATOR']} />
      <LaneLabel y={BUYER_Y + 52} lines={['BUYER /', 'SELLER']} />
      <LaneLabel y={CONTRACT_Y + 106} lines={['CONTRACTS']} />

      {/* ── Launch ────────────────────────────────────────────────────────── */}
      <Box
        x={S1}
        y={54}
        w={244}
        h={83}
        title="Fill the form"
        lines={['image compressed in browser', 'metadata pinned to IPFS', `approve ${f.creationFee} creation fee`]}
      />
      <Edge d={`M226 137 V352`} marker={seq} />
      <EdgeLabel x={234} y={250}>
        launch()
      </EdgeLabel>

      <Box x={S1} y={352} w={244} h={53} title="HoodiumFactory" titleMono lines={['immutable · no admin keys']} />
      <Edge d="M180 405 L163 423" marker={seq} />
      <Edge d="M272 405 L289 423" marker={seq} />
      <EdgeLabel x={226} y={418} anchor="middle">
        deploys
      </EdgeLabel>
      <Box x={S1} y={423} w={118} h={42} title="HoodiumToken" titleMono lines={['fixed supply']} bodySize={9.5} pad={9} />
      <Box
        x={S1 + 126}
        y={423}
        w={118}
        h={42}
        title="BondingCurve"
        titleMono
        lines={['immutable params']}
        bodySize={9.5}
        pad={9}
        lock
      />
      <Box
        x={S1}
        y={483}
        w={244}
        h={64}
        dashed
        bodySize={10}
        lines={[
          `optional dev buy, capped at ${f.devBuyMax}% of`,
          `supply — counted against the ${f.snipeMax}% /`,
          `${f.snipeBlocks}-block anti-snipe cap`,
        ]}
      />

      {/* ── Curve ─────────────────────────────────────────────────────────── */}
      <Box x={S2} y={94} w={170} h={68} title="Creator fee" lines={[`${f.creatorShare}% of every trade fee`, 'claim any time']} />
      <Edge d="M380 352 V162" money marker={money} />
      <EdgeLabel x={388} y={182} money>
        {`${f.creatorShare}% of fee`}
      </EdgeLabel>

      <Chip x={420} y={196} w={200} h={32} text={`approve ${q} once`} />
      <Edge d="M520 228 V240" marker={seq} />
      <Chip x={420} y={240} w={200} h={32} text={`buy(): ${q} in, tokens out`} />
      <Chip x={420} y={284} w={200} h={32} text={`sell(): tokens in, ${q} out`} />
      <Edge d="M420 256 H406 V352" money marker={money} />
      <Edge d="M420 300 H406" money />
      {/* Right of the trunk, not left: to the left it lands on the creator-fee
          arrow and reads as that arrow's label. */}
      <EdgeLabel x={414} y={346} money>
        {`${f.tradeFee}% fee`}
      </EdgeLabel>

      <Box
        x={S2}
        y={352}
        w={260}
        h={98}
        title="BondingCurve"
        titleMono
        lines={[
          'price rises with every buy,',
          'falls with every sell',
          `${f.tradeFee}% fee on both sides`,
          'sells stop once it completes',
        ]}
      />
      <Edge d="M400 450 V474" money marker={money} />
      <EdgeLabel x={408} y={468} money>
        {`${f.hoodiumShare}% of fee`}
      </EdgeLabel>
      <Box x={S2} y={474} w={200} h={53} title="FeeVault" titleMono lines={["Hoodium's multisig"]} />

      {/* ── Graduation ────────────────────────────────────────────────────── */}
      <Box
        x={S3}
        y={240}
        w={268}
        h={53}
        title="The buy that reaches the target"
        lines={[`${f.target} — nothing extra to do`]}
      />
      <Edge d="M766 293 V352" marker={seq} />
      <EdgeLabel x={774} y={330}>
        same transaction
      </EdgeLabel>
      <Box
        x={S3}
        y={352}
        w={268}
        h={98}
        title="Graduation — automatic"
        lines={[
          `the curve closes at ${f.target}`,
          `remaining ${q} + ${f.lpAllocation} tokens seed`,
          'a full-range Uniswap v3 pool at',
          "the curve's closing price",
        ]}
      />
      <Edge d="M680 450 V474" dashed marker={seq} />
      <Box
        x={S3}
        y={474}
        w={268}
        h={78}
        dashed
        bodySize={10}
        title="Rare branch"
        lines={['pool primed at a hostile price?', 'GraduationHelper.fixAndBuy()', 're-prices it and completes it']}
      />

      {/* ── Locked pool ───────────────────────────────────────────────────── */}
      <Box x={S4} y={94} w={160} h={68} title="Pool fees" lines={[`${f.lpCreatorShare}% to the creator`, 'collect any time']} />
      <Box x={S4} y={240} w={160} h={53} title="Trade on the pool" lines={['Uniswap v3, 1% tier']} />
      <Edge d="M900 394 H922" marker={seq} />
      <Box
        x={S4}
        y={352}
        w={186}
        h={84}
        title="LPLocker"
        titleMono
        lock
        lines={["holds the pool's LP NFT", 'no withdrawal path']}
        note="irreversible"
      />
      <Edge d="M1019 436 V456" marker={seq} />
      <Box
        x={S4}
        y={456}
        w={186}
        h={83}
        title="Swap fees"
        bodySize={10.5}
        lines={[
          `${f.lpCreatorShare}% creator, ${f.lpProtocolShare}% protocol`,
          'anyone can sweep the',
          "protocol's share",
        ]}
      />
      <Edge d="M1102 456 V128 H1088" money marker={money} />
      <EdgeLabel x={1096} y={210} money anchor="end">
        {`${f.lpCreatorShare}%`}
      </EdgeLabel>

      {/* ── Legend ────────────────────────────────────────────────────────── */}
      <g>
        <Lock x={S1} y={583} />
        <text x={S1 + 16} y={592} fill={PRIMARY} fontSize={10} className="font-mono">
          irreversible
        </text>
        <line x1={220} y1={588} x2={240} y2={588} stroke={PRIMARY} strokeWidth={1.25} markerEnd={`url(#${money})`} />
        <text x={248} y={592} fill={MUTED} fontSize={10} className="font-mono">
          value moves
        </text>
        <line x1={350} y1={588} x2={370} y2={588} stroke={MUTED} strokeWidth={1.25} markerEnd={`url(#${seq})`} />
        <text x={378} y={592} fill={MUTED} fontSize={10} className="font-mono">
          then
        </text>
      </g>
    </svg>
  )
}

/* ── The compact drawing: the same flow, one column ─────────────────────────── */

type CompactStep = {
  actor: string
  title: string
  lines: string[]
  note?: string
  lock?: boolean
  dashed?: boolean
  /** The label on the edge that leads *into* this step. */
  edge?: string
  edgeMoney?: boolean
  edgeDashed?: boolean
}

const COMPACT_W = 360
const COMPACT_PAD = 6
const COMPACT_BODY = 9.5
const TAG_H = 12
const EDGE_H = 30

function compactSteps(f: LifecycleFigures): CompactStep[] {
  const q = f.quoteSymbol
  return [
    {
      actor: 'Creator',
      title: 'Fill the form',
      lines: ['image compressed, metadata pinned to IPFS', `approve ${f.creationFee}, then call launch()`],
    },
    {
      actor: 'Contracts',
      title: 'HoodiumFactory deploys',
      edge: 'launch()',
      lock: true,
      lines: [
        'HoodiumToken — fixed supply, no mint',
        'BondingCurve — parameters immutable',
        `optional dev buy ≤ ${f.devBuyMax}% of supply, counted`,
        `against the ${f.snipeMax}% cap for ${f.snipeBlocks} blocks`,
      ],
    },
    {
      actor: 'Buyer / seller',
      title: 'Trade against the curve',
      edge: 'the curve opens',
      lines: [
        `approve ${q}, then buy() or sell()`,
        `buy(): ${q} in, tokens out — price rises`,
        `sell(): tokens in, ${q} out — price falls`,
      ],
    },
    {
      actor: 'Contracts',
      title: `BondingCurve takes ${f.tradeFee}% of each trade`,
      edge: `${f.tradeFee}% fee`,
      edgeMoney: true,
      lines: [
        `${f.creatorShare}% → the creator, claimable any time`,
        `${f.hoodiumShare}% → FeeVault, Hoodium's multisig`,
        'sells are refused once the curve completes',
      ],
    },
    {
      actor: 'Contracts',
      title: 'Graduation — inside that buy',
      edge: `at ${f.target} raised`,
      edgeMoney: true,
      lines: [
        `the curve closes; remaining ${q} and the`,
        `${f.lpAllocation} tokens held back seed a full-range`,
        "Uniswap v3 pool at exactly the curve's",
        'closing price',
      ],
    },
    {
      actor: 'Rare branch',
      title: 'If the pool was primed',
      edge: 'hostile price',
      edgeDashed: true,
      dashed: true,
      lines: ['GraduationHelper.fixAndBuy() re-prices it', 'and completes the curve in one call'],
    },
    {
      actor: 'Contracts',
      title: 'Locked pool, and trading moves there',
      edge: 'pool is live',
      lock: true,
      lines: [
        'the LP NFT goes to LPLocker — there is',
        'no withdrawal path, ever',
        `swap fees: ${f.lpCreatorShare}% creator, ${f.lpProtocolShare}% protocol;`,
        "anyone can sweep the protocol's share",
      ],
      note: 'irreversible',
    },
  ]
}

function CompactDiagram({ f, uid, className }: { f: LifecycleFigures; uid: string; className?: string }) {
  const seq = `${uid}-tall-seq`
  const money = `${uid}-tall-money`
  const steps = compactSteps(f)
  const boxHeight = (s: CompactStep) => 28 + s.lines.length * (COMPACT_BODY + 4) + (s.note ? 15 : 0) + 10

  let cursor = 4
  const placed = steps.map((s) => {
    const top = cursor + (s.edge ? EDGE_H : 0) + TAG_H
    const h = boxHeight(s)
    const at = { step: s, top, h, edgeFrom: cursor }
    cursor = top + h
    return at
  })
  const height = cursor + 34

  return (
    <svg
      viewBox={`0 0 ${COMPACT_W} ${height}`}
      className={cn('mx-auto h-auto w-full max-w-[520px]', className)}
      role="img"
      aria-label={ACCESSIBLE_NAME}
      focusable="false"
    >
      <title>How a token moves through Hoodium Launchpad</title>
      <desc>{ACCESSIBLE_NAME}</desc>
      <Markers seq={seq} money={money} />

      {placed.map(({ step, top, h, edgeFrom }) => (
        <g key={step.title}>
          {step.edge && (
            <>
              <Edge
                d={`M${COMPACT_PAD + 18} ${edgeFrom} V${top - TAG_H - 4}`}
                money={step.edgeMoney}
                dashed={step.edgeDashed}
                marker={step.edgeMoney ? money : seq}
              />
              <EdgeLabel x={COMPACT_PAD + 28} y={edgeFrom + 18} money={step.edgeMoney} size={9.5}>
                {step.edge}
              </EdgeLabel>
            </>
          )}
          <text
            x={COMPACT_PAD}
            y={top - 5}
            fill={MUTED}
            fontSize={8.5}
            letterSpacing={1.1}
            className="font-mono"
          >
            {step.actor.toUpperCase()}
          </text>
          <Box
            x={COMPACT_PAD}
            y={top}
            w={COMPACT_W - COMPACT_PAD * 2}
            h={h}
            title={step.title}
            lines={step.lines}
            note={step.note}
            lock={step.lock}
            dashed={step.dashed}
            bodySize={COMPACT_BODY}
            pad={11}
          />
        </g>
      ))}

      <g>
        <Lock x={COMPACT_PAD} y={height - 21} />
        <text x={COMPACT_PAD + 15} y={height - 12} fill={PRIMARY} fontSize={9.5} className="font-mono">
          irreversible
        </text>
        <line
          x1={112}
          y1={height - 16}
          x2={130}
          y2={height - 16}
          stroke={PRIMARY}
          strokeWidth={1.25}
          markerEnd={`url(#${money})`}
        />
        <text x={138} y={height - 12} fill={MUTED} fontSize={9.5} className="font-mono">
          value moves
        </text>
      </g>
    </svg>
  )
}

/* ── The words, for readers who cannot open the picture ─────────────────────── */

function srSteps(f: LifecycleFigures): string[] {
  const q = f.quoteSymbol
  return [
    `Creator: fills the launch form. The image is compressed in the browser and the metadata is pinned to ` +
      `IPFS. The creator approves the ${f.creationFee} creation fee and calls launch().`,
    `Contracts: HoodiumFactory deploys a HoodiumToken with a fixed supply and a BondingCurve whose ` +
      `parameters are immutable. The creator may buy in the same transaction, capped at ${f.devBuyMax}% of ` +
      `supply, and that dev buy counts against the ${f.snipeMax}% per-address anti-snipe cap that applies ` +
      `for the first ${f.snipeBlocks} blocks.`,
    `Buyer or seller: approves ${q}, then calls buy() — ${q} in, tokens out, and the price rises along the ` +
      `curve — or sell(), which returns ${q} and lowers the price.`,
    `Contracts: the curve takes ${f.tradeFee}% of every trade and splits it ${f.creatorShare}% to the ` +
      `creator, who can claim at any time, and ${f.hoodiumShare}% to the FeeVault multisig. Sells are ` +
      `refused once the curve completes.`,
    `Graduation, automatic and inside the buy that reaches the target: at ${f.target} raised the curve ` +
      `closes, and the remaining ${q} together with the ${f.lpAllocation} tokens held back seed a ` +
      `full-range Uniswap v3 pool at exactly the curve's closing price.`,
    `Rare branch: if someone primed the pool at a hostile price, GraduationHelper.fixAndBuy() re-prices it ` +
      `and completes the curve in one call.`,
    `Locked pool: the LP NFT goes to LPLocker, which has no withdrawal path — this is irreversible. Trading ` +
      `continues on the Uniswap v3 pool, and its swap fees split ${f.lpCreatorShare}% to the creator and ` +
      `${f.lpProtocolShare}% to the protocol, with anyone able to sweep the protocol's share.`,
  ]
}

export function LifecycleDiagram({ figures, className }: { figures: LifecycleFigures; className?: string }) {
  /* Both drawings are in the DOM at once and each carries its own `<defs>`:
     ids shared between them would resolve to the hidden SVG's markers, and a
     marker inside `display: none` draws nothing — which is exactly how the
     column lost every arrowhead the first time round. */
  const uid = useId().replace(/:/g, '')

  return (
    <figure className={cn('m-0', className)}>
      <WideDiagram f={figures} uid={uid} className="hidden xl:block" />
      <CompactDiagram f={figures} uid={uid} className="xl:hidden" />
      <ol className="sr-only">
        {srSteps(figures).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <figcaption className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Your wallet signs every step on the creator and trader lanes; the contract lane runs on its own, with
        no admin key anywhere in it. The two padlocks mark what nothing can undo — the curve's parameters and
        the locked LP.
      </figcaption>
    </figure>
  )
}
