/**
 * T1.6 / WA-N4 — "An ESLint rule flags `Number(`, `parseFloat(`, and arithmetic
 * operators applied to values typed as `bigint | string`" (design.md section 7).
 *
 * This is the type-unaware version of that rule: it identifies money by
 * identifier naming rather than by consulting the type checker. A type-aware
 * rule would be stricter and remains the natural upgrade.
 *
 * ── What it deliberately does not flag ───────────────────────────────────────
 * Naming alone produced enough false positives that `npm run lint` was red on
 * main, and a rule that is always red is a rule people stop reading. Four
 * exemptions, each provable from the syntax without a type checker:
 *
 *   1. **bigint operands.** `(totalSupply * 80n) / 100n` is exact — it is the
 *      arithmetic this rule exists to push people towards. Flagging it inverted
 *      the requirement. Resolved one hop through local declarations, so a value
 *      built from bigint literals is still recognised where it is used.
 *   2. **Values explicitly annotated `number`.** The author has already declared
 *      it a float; any violation happened at the conversion, which is reported
 *      at its own site. `formatPrice(price: number)` dividing to render "1.2K"
 *      is formatting, not money math.
 *   3. **`const x = Number(raw)`.** Same reasoning — the cause is reported once,
 *      at the conversion, rather than at every use of its result.
 *   4. **Proportions.** `feeTier` is basis points, `liquidityTrendPct` is a
 *      percentage. Neither is an amount; both matched only because the prefix
 *      test cannot see past the first word.
 *
 * What still fires — and what the probe cases in the commit that introduced these
 * exemptions confirm still fires — is the case that matters: money arriving as a
 * string or bigint and being converted or multiplied without ceremony.
 *
 * The escape hatch remains an explicit `// eslint-disable-next-line` **with a
 * reason**. The two in the codebase are chart coordinates and tick math, both
 * genuinely float domains. Note the directive must be the first token in its
 * comment — a reason wrapped onto a second line silently disables nothing.
 */

const MONEY_NAMES =
  /^(value|amount|amount0|amount1|price|liquidity|valueQuote|balance|cost|fee|fees|pnl|total|reserve|supply|marketCap|mc)([A-Z_]|$)/

/**
 * Suffixes that name a *proportion*, not an amount.
 *
 * `feeTier` is 3000 basis points, `liquidityTrendPct` is a percentage — neither
 * is money, and neither loses anything as a float. They matched only because the
 * prefix test cannot see past the first word. A rule that cries wolf on these
 * teaches people to reach for `eslint-disable`, which costs more than it saves.
 */
const RATIO_NAMES = /(Pct|Percent|Bps|Tier|Ratio|Trend|Count|Decimals)$/

const BANNED_CALLS = new Set(['Number', 'parseFloat', 'parseInt'])

function isMoneyName(name) {
  return MONEY_NAMES.test(name) && !RATIO_NAMES.test(name)
}

function looksLikeMoney(node) {
  if (!node) return false
  if (node.type === 'Identifier') return isMoneyName(node.name)
  if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    return isMoneyName(node.property.name)
  }
  return false
}

/** @type {import('eslint').Rule.RuleModule} */
export const noNumberOnMoney = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Money must stay string/bigint end to end (WA-N4). A JS Number cannot represent 0.1 exactly ' +
        'and silently rounds above 2^53.',
    },
    schema: [],
    messages: {
      bannedCall:
        '{{callee}}() on a monetary value violates WA-N4 — money must stay a string or bigint. ' +
        'Use the helpers in @/lib/money.',
      bannedArithmetic:
        "'{{operator}}' applied to a monetary value violates WA-N4. Use compareMoney/round from @/lib/money.",
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || !BANNED_CALLS.has(node.callee.name)) return
        const [arg] = node.arguments
        if (!looksLikeMoney(arg)) return

        context.report({ node, messageId: 'bannedCall', data: { callee: node.callee.name } })
      },

      BinaryExpression(node) {
        if (!['+', '-', '*', '/', '%', '**', '<', '>', '<=', '>='].includes(node.operator)) return
        if (!looksLikeMoney(node.left) && !looksLikeMoney(node.right)) return

        // String concatenation onto a template is not arithmetic.
        if (node.operator === '+' && (isStringLiteral(node.left) || isStringLiteral(node.right))) return

        const scope = context.sourceCode.getScope(node)

        // bigint arithmetic is exact — it is what WA-N4 asks for, not a breach of it.
        if (isBigIntish(node.left, scope) || isBigIntish(node.right, scope)) return

        // Both sides explicitly `number`: this is display formatting, and the
        // conversion that produced them is flagged at its own site.
        const leftOk = !looksLikeMoney(node.left) || isDeclaredNumber(node.left, scope)
        const rightOk = !looksLikeMoney(node.right) || isDeclaredNumber(node.right, scope)
        if (leftOk && rightOk) return

        context.report({ node, messageId: 'bannedArithmetic', data: { operator: node.operator } })
      },
    }
  },
}

function isStringLiteral(node) {
  return node.type === 'Literal' && typeof node.value === 'string'
}

/**
 * Resolve an identifier to the definition that introduced it, or null.
 *
 * Returns the definition rather than its node because the two carry different
 * halves of what is needed: a parameter's type annotation hangs off `def.name`,
 * while a variable's initialiser hangs off `def.node`.
 */
function defOf(node, scope) {
  if (!scope || node.type !== 'Identifier') return null
  for (let s = scope; s; s = s.upper) {
    const variable = s.variables.find((v) => v.name === node.name)
    if (variable) return variable.defs[0] ?? null
  }
  return null
}

function annotationOf(def) {
  return def?.name?.typeAnnotation?.typeAnnotation ?? def?.node?.id?.typeAnnotation?.typeAnnotation ?? null
}

/**
 * Is this value explicitly declared `number`?
 *
 * If it is, the author has already stated it is a float, and any WA-N4 violation
 * happened at the conversion — which this rule flags separately as a banned call.
 * Arithmetic on an already-converted display value is formatting, not money math:
 * `formatPrice(price: number)` dividing to render "1.2K" is doing its job.
 */
function isDeclaredNumber(node, scope) {
  const def = defOf(node, scope)
  if (annotationOf(def)?.type === 'TSNumberKeyword') return true

  /*
   * `const value = Number(raw)` is a number by construction. If `raw` had been
   * money, the conversion itself is reported at its own site — which is where
   * the violation actually is, and where it can actually be fixed.
   */
  const init = def?.node?.init
  return init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'Number'
}

/**
 * Is this expression made of bigints?
 *
 * Flagging bigint arithmetic inverts the requirement. WA-N4 exists because a JS
 * `Number` cannot hold 0.1 and rounds above 2^53; a `bigint` has neither problem,
 * and `(totalSupply * 80n) / 100n` is exactly the arithmetic the rule is meant to
 * push people towards. Resolves one hop through local declarations so a value
 * built from bigint literals is still recognised where it is used.
 */
function isBigIntish(node, scope, depth = 0) {
  if (!node || depth > 4) return false

  if (node.type === 'Literal' && typeof node.value === 'bigint') return true
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'BigInt') {
    return true
  }
  if (node.type === 'BinaryExpression') {
    return isBigIntish(node.left, scope, depth + 1) || isBigIntish(node.right, scope, depth + 1)
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression') {
    return isBigIntish(node.expression, scope, depth + 1)
  }
  if (node.type === 'Identifier') {
    const def = defOf(node, scope)
    if (annotationOf(def)?.type === 'TSBigIntKeyword') return true
    return isBigIntish(def?.node?.init, scope, depth + 1)
  }
  return false
}

export default { rules: { 'no-number-on-money': noNumberOnMoney } }
