import assert from 'node:assert/strict'
import {
  PolicyRunStateError,
  PolicyRunStore,
  policyHash,
  type ActivePlan,
  type CreatePlanInput,
} from '../server/policyRunState.ts'
import { planNextTrade } from '../src/nextTradePlanner.ts'
import type { NextTradeDecision } from '../src/nextTradePlanner.ts'
import type { Policy } from '../src/rules.ts'

const basePolicy: Policy = {
  sourceText: 'Keep at least 40% in USDC.',
  rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 40 }, { kind: 'protected_asset', asset: 'BTC' }],
}
const changedPolicy: Policy = {
  sourceText: 'Keep at least 50% in USDC.',
  rules: [{ kind: 'min_stablecoin', asset: 'USDC', minPct: 50 }, { kind: 'protected_asset', asset: 'BTC' }],
}
const now = Date.parse('2026-09-07T12:00:00.000Z')
const originalDateNow = Date.now
Date.now = () => now

function readyDecision(tag: string): Extract<NextTradeDecision, { status: 'READY' }> {
  const decision = planNextTrade([
    { symbol: 'SOL', name: 'Solana', quantity: 2, free: 2, locked: 0, priceUsd: 1, change24h: 0, kind: 'altcoin' },
    { symbol: 'USDC', name: 'USD Coin', quantity: 0, free: 0, locked: 0, priceUsd: 1, change24h: 0, kind: 'stablecoin' },
  ], basePolicy, { runId: `planner-${tag}`, settlementAsset: 'USDC' })
  assert.equal(decision.status, 'READY')
  if (decision.status !== 'READY') throw new Error('Expected a planner decision.')
  return decision
}

function planInput(tag: string, ttlMs = 60_000): CreatePlanInput {
  return {
    decision: readyDecision(tag),
    snapshotHash: `snapshot-${tag}-hash`,
    executableIntent: {
      symbol: 'SOLUSDC',
      side: 'SELL',
      type: 'MARKET',
      quantity: 10 + tag.length,
      newClientOrderId: `rokai-${tag}`,
    },
    protectedAssets: ['BTC'],
    ttlMs,
  }
}

function createPendingStore(tag = 'one', ttlMs?: number): { store: PolicyRunStore; runId: string; plan: ActivePlan } {
  const store = new PolicyRunStore()
  const run = store.createRun(basePolicy, now)
  store.beginPlanning(run.runId, now + 1)
  const plan = store.createPlan(run.runId, planInput(tag, ttlMs), now + 2)
  assert.ok(plan)
  return { store, runId: run.runId, plan }
}

const initialStore = new PolicyRunStore()
const initialRun = initialStore.createRun(basePolicy, now)
assert.match(initialRun.runId, /^[0-9a-f-]{36}$/)
assert.equal(initialRun.policyHash, policyHash(basePolicy))
assert.deepEqual(initialRun.originalPolicy, basePolicy)
assert.equal(initialRun.status, 'READING')
assert.equal(initialRun.currentStep, 0)
assert.equal(initialRun.maxTrades, 3)
assert.equal(initialRun.tradeCount, 0)
assert.equal(initialRun.activePlanId, null)
assert.equal(initialRun.historyPlanIds.length, 0)

const first = createPendingStore()
assert.match(first.plan.planId, /^[0-9a-f-]{36}$/)
assert.equal(first.plan.runId, first.runId)
assert.equal(first.plan.status, 'PENDING')
assert.equal(first.plan.snapshotHash, 'snapshot-one-hash')
assert.equal(first.plan.protectedAssets[0], 'BTC')
assert.equal(first.store.getRun(first.runId).status, 'AWAITING_APPROVAL')
assert.equal(first.store.getRun(first.runId).activePlanId, first.plan.planId)

const clonedPlan = first.store.getActivePlan(first.runId)
assert.ok(clonedPlan)
if (clonedPlan) clonedPlan.status = 'CONSUMED'
assert.equal(first.store.getActivePlan(first.runId)?.status, 'PENDING')
assert.throws(() => first.store.approve(first.runId, 'Approve', now + 3), (error: unknown) => error instanceof PolicyRunStateError && error.code === 'INVALID_APPROVAL')
assert.throws(() => first.store.approve(first.runId, `APPROVE ${first.plan.planId}-wrong`, now + 3), /must exactly match/i)
const approved = first.store.approve(first.runId, `APPROVE ${first.plan.planId}`, now + 3)
assert.equal(approved.status, 'SUBMITTING')
assert.equal(first.store.getActivePlan(first.runId)?.status, 'SUBMITTING')
assert.equal(approved.tradeCount, 0)
assert.deepEqual(approved.submittedPayloadHashes, [])
const claimed = first.store.claimSubmission(first.runId, first.plan.planId, first.plan.payloadHash)
assert.equal(claimed.tradeCount, 1)
assert.deepEqual(claimed.submittedPayloadHashes, [first.plan.payloadHash])
assert.throws(() => first.store.claimSubmission(first.runId, first.plan.planId, first.plan.payloadHash), /single-use|already/i)
assert.throws(() => first.store.approve(first.runId, `APPROVE ${first.plan.planId}`, now + 4), /already been submitted|already been submitted|submitted/i)

const handcraftedStore = new PolicyRunStore()
const handcraftedRun = handcraftedStore.createRun(basePolicy)
const handcraftedDecision = JSON.parse(JSON.stringify(readyDecision('handcrafted')))
assert.throws(() => handcraftedStore.createPlan(handcraftedRun.runId, {
  decision: handcraftedDecision,
  snapshotHash: 'snapshot-handcrafted-hash',
  executableIntent: planInput('handcrafted').executableIntent,
  protectedAssets: ['BTC'],
}), /deterministic planner|planner/i)

const changedPayload = createPendingStore('payload')
assert.throws(
  () => changedPayload.store.approve(changedPayload.runId, `APPROVE ${changedPayload.plan.planId}`, now + 3, { executableIntent: { changed: true } }),
  /payload/i,
)
assert.equal(changedPayload.store.getActivePlan(changedPayload.runId), null)
assert.equal(changedPayload.store.getRun(changedPayload.runId).status, 'MANUAL_REVIEW')
const changedPolicyStore = createPendingStore('policy-context')
assert.throws(
  () => changedPolicyStore.store.approve(changedPolicyStore.runId, `APPROVE ${changedPolicyStore.plan.planId}`, now + 3, { policy: changedPolicy }),
  /policy/i,
)

const expired = createPendingStore('expired')
Date.now = () => now + 60_001
assert.throws(() => expired.store.approve(expired.runId, `APPROVE ${expired.plan.planId}`), /expired/i)
Date.now = () => now
assert.equal(expired.store.getActivePlan(expired.runId), null)
assert.equal(expired.store.getRun(expired.runId).status, 'PLANNING')

const wrongRun = createPendingStore('wrong-run')
assert.throws(() => wrongRun.store.approve('00000000-0000-0000-0000-000000000000', `APPROVE ${wrongRun.plan.planId}`, now + 3), /does not exist/i)

const replaced = createPendingStore('replace-a')
const replacement = replaced.store.createPlan(replaced.runId, planInput('replace-bb'), now + 4)
assert.ok(replacement)
assert.notEqual(replacement?.planId, replaced.plan.planId)
assert.equal(replaced.store.getActivePlan(replaced.runId)?.planId, replacement?.planId)
assert.ok(replaced.store.getRun(replaced.runId).historyPlanIds.includes(replaced.plan.planId))
assert.throws(() => replaced.store.approve(replaced.runId, `APPROVE ${replaced.plan.planId}`, now + 5), /exactly match|active/i)

const stale = createPendingStore('stale')
stale.store.noteAccountRefresh(stale.runId, now + 4)
assert.equal(stale.store.getActivePlan(stale.runId), null)
assert.ok(stale.store.getRun(stale.runId).historyPlanIds.includes(stale.plan.planId))
assert.throws(() => stale.store.approve(stale.runId, `APPROVE ${stale.plan.planId}`, now + 5), /active plan/i)

const oldAfterReplan = createPendingStore('replan-a')
oldAfterReplan.store.notePriceRefresh(oldAfterReplan.runId, now + 4)
const replanned = oldAfterReplan.store.replan(oldAfterReplan.runId, planInput('replan-bb'), now + 5)
assert.ok(replanned)
assert.notEqual(replanned?.planId, oldAfterReplan.plan.planId)
assert.equal(oldAfterReplan.store.getRun(oldAfterReplan.runId).currentStep, 2)
assert.throws(() => oldAfterReplan.store.approve(oldAfterReplan.runId, `APPROVE ${oldAfterReplan.plan.planId}`, now + 6), /active|exactly match/i)

const policyChanged = createPendingStore('policy')
policyChanged.store.notePolicyChange(policyChanged.runId, changedPolicy, now + 4)
assert.equal(policyChanged.store.getActivePlan(policyChanged.runId), null)
assert.equal(policyChanged.store.getRun(policyChanged.runId).status, 'MANUAL_REVIEW')
assert.throws(() => policyChanged.store.approve(policyChanged.runId, `APPROVE ${policyChanged.plan.planId}`, now + 5), /active plan/i)

const noProgress = createPendingStore('no-progress')
noProgress.store.approve(noProgress.runId, `APPROVE ${noProgress.plan.planId}`, now + 3)
noProgress.store.claimSubmission(noProgress.runId, noProgress.plan.planId, noProgress.plan.payloadHash)
noProgress.store.beginVerification(noProgress.runId, noProgress.plan.planId, now + 4)
const noProgressRun = noProgress.store.recordVerification(noProgress.runId, noProgress.plan.planId, { violationScoreBefore: 1, violationScoreAfter: 1, complete: false }, now + 5)
assert.equal(noProgressRun.status, 'MANUAL_REVIEW')
assert.equal(noProgress.store.getActivePlan(noProgress.runId), null)

const maxTrades = new PolicyRunStore()
const maxRun = maxTrades.createRun(basePolicy, now)
for (const [index, tag] of ['max-a', 'max-bb', 'max-ccc'].entries()) {
  if (index > 0) assert.equal(maxTrades.getRun(maxRun.runId).status, 'READING')
  const maxPlan = maxTrades.replan(maxRun.runId, planInput(tag), now + index * 10 + 1)
  assert.ok(maxPlan)
  maxTrades.approve(maxRun.runId, `APPROVE ${maxPlan!.planId}`, now + index * 10 + 2)
  maxTrades.claimSubmission(maxRun.runId, maxPlan!.planId, maxPlan!.payloadHash)
  maxTrades.beginVerification(maxRun.runId, maxPlan!.planId, now + index * 10 + 3)
  const result = maxTrades.recordVerification(maxRun.runId, maxPlan!.planId, { violationScoreBefore: 3 - index, violationScoreAfter: 2 - index, complete: false }, now + index * 10 + 4)
  if (index === 2) assert.equal(result.status, 'MANUAL_REVIEW')
}
assert.equal(maxTrades.getRun(maxRun.runId).tradeCount, 3)
assert.throws(() => maxTrades.replan(maxRun.runId, planInput('max-d'), now + 40), /manual|state/i)

const harmlessPriceRefresh = createPendingStore('harmless-price')
harmlessPriceRefresh.store.notePriceRefresh(harmlessPriceRefresh.runId, now + 4)
const harmlessReplan = harmlessPriceRefresh.store.replan(harmlessPriceRefresh.runId, planInput('harmless-price'), now + 5)
assert.ok(harmlessReplan)

const duplicate = createPendingStore('duplicate')
duplicate.store.approve(duplicate.runId, `APPROVE ${duplicate.plan.planId}`, now + 3)
duplicate.store.claimSubmission(duplicate.runId, duplicate.plan.planId, duplicate.plan.payloadHash)
duplicate.store.noteAccountRefresh(duplicate.runId, now + 4)
const semanticallyRepeatedIntent = planInput('duplicate')
semanticallyRepeatedIntent.executableIntent = {
  ...(semanticallyRepeatedIntent.executableIntent as Record<string, unknown>),
  newClientOrderId: 'rokai-new-random-client-id',
}
assert.throws(() => duplicate.store.replan(duplicate.runId, semanticallyRepeatedIntent, now + 5), /same order intent|duplicate/i)
assert.equal(duplicate.store.getRun(duplicate.runId).status, 'MANUAL_REVIEW')

const restart = createPendingStore('restart')
restart.store.restartRun(restart.runId, now + 4)
assert.equal(restart.store.getActivePlan(restart.runId), null)
assert.equal(restart.store.getRun(restart.runId).status, 'MANUAL_REVIEW')
assert.throws(() => restart.store.approve(restart.runId, `APPROVE ${restart.plan.planId}`, now + 5), /active plan/i)
const freshProcess = new PolicyRunStore()
assert.throws(() => freshProcess.approve(restart.runId, `APPROVE ${restart.plan.planId}`, now + 5), /does not exist/i)

console.log('policy run state fixtures passed')
Date.now = originalDateNow
