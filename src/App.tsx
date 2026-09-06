import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Command,
  Database,
  LockKeyhole,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Sparkles,
  WalletCards,
  X,
} from 'lucide-react'
import { cloneMockAssets, DEMO_POLICY_TEXT, fixtureTimestamp, type Asset } from './mockData'
import {
  applyPlan,
  buildPlan,
  evaluateRules,
  parseDemoPolicy,
  valuePortfolio,
  type Plan,
  type Policy,
  type RuleResult,
} from './rules'
import { requestPolicyParse } from './policyParser'

type Route = '/' | '/analysis' | '/result'
type FlowState = 'idle' | 'checked' | 'approved' | 'verified'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const moneyPrecise = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

function readRoute(): Route {
  if (window.location.pathname === '/analysis') return '/analysis'
  if (window.location.pathname === '/result') return '/result'
  return '/'
}

function pct(value: number) { return `${value.toFixed(1)}%` }

function ruleTitle(result: RuleResult) {
  if (result.rule.kind === 'min_stablecoin') return `${result.rule.asset} Reserve`
  if (result.rule.kind === 'protected_asset') return `${result.rule.asset} Protection`
  const symbol = result.detail.match(/^([A-Z0-9]+)/)?.[1] ?? 'Altcoin'
  return `${symbol} Exposure`
}

function ruleTarget(result: RuleResult) {
  if (result.rule.kind === 'min_stablecoin') return `${pct(result.targetPct)} minimum`
  if (result.rule.kind === 'protected_asset') return 'Protected'
  return `${pct(result.targetPct)} maximum`
}

function App() {
  const [route, setRoute] = useState<Route>(() => readRoute())
  const [input, setInput] = useState(DEMO_POLICY_TEXT)
  const [assets, setAssets] = useState<Asset[]>(cloneMockAssets)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [flow, setFlow] = useState<FlowState>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [parserSource, setParserSource] = useState<'gemini' | 'fallback' | null>(null)

  useEffect(() => {
    const onPopState = () => setRoute(readRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((nextRoute: Route) => {
    if (window.location.pathname !== nextRoute) window.history.pushState({}, '', nextRoute)
    setRoute(nextRoute)
  }, [])

  useEffect(() => {
    if (route !== '/' && !policy) navigate('/')
  }, [navigate, policy, route])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [route])

  const portfolio = useMemo(() => valuePortfolio(assets), [assets])
  const results = useMemo(() => policy ? evaluateRules(assets, policy) : [], [assets, policy])
  const currentPlan = useMemo(() => policy ? buildPlan(assets, policy) : null, [assets, policy])
  const previewAssets = useMemo(
    () => plan && flow !== 'verified' ? applyPlan(assets, plan) : assets,
    [assets, flow, plan],
  )
  const previewResults = useMemo(() => policy ? evaluateRules(previewAssets, policy) : [], [policy, previewAssets])

  async function checkPortfolio() {
    setError('')
    setNotice('')
    setParserSource(null)
    setIsAnalyzing(true)
    const parsed = await requestPolicyParse(input)
    let nextPolicy = parsed.policy

    if (!nextPolicy) {
      const fallback = parseDemoPolicy(input)
      if (fallback.policy) {
        nextPolicy = fallback.policy
        setParserSource('fallback')
        setNotice('Gemini unavailable. Using the deterministic mock parser for this supported rule.')
      } else {
        setError(parsed.error ? `${parsed.error} ${fallback.error ?? ''}`.trim() : fallback.error ?? 'Could not understand that rule.')
        setPolicy(null)
        setPlan(null)
        setFlow('idle')
        setIsAnalyzing(false)
        return
      }
    } else {
      setParserSource('gemini')
    }

    setPolicy(nextPolicy)
    setPlan(buildPlan(assets, nextPolicy))
    setFlow('checked')
    setIsAnalyzing(false)
    navigate('/analysis')
  }

  function approvePlan() {
    if (!currentPlan || !currentPlan.safe || !currentPlan.actions.length) return
    setPlan(currentPlan)
    setFlow('approved')
    navigate('/result')
  }

  const completeMockExecution = useCallback(() => {
    if (!plan) return
    setAssets((current) => applyPlan(current, plan))
    setFlow('verified')
  }, [plan])

  function resetFlow() {
    setAssets(cloneMockAssets())
    setPolicy(null)
    setPlan(null)
    setFlow('idle')
    setError('')
    setNotice('')
    setParserSource(null)
    setInput(DEMO_POLICY_TEXT)
    navigate('/')
  }

  return (
    <main className="app-shell">
      <div className="background-grid" aria-hidden="true" />
      <Header route={route} onConnect={() => setNotice('Binance connection is reserved for a later phase.')} />
      <div className="page-frame" key={route}>
        {route === '/' && <LandingPage input={input} setInput={setInput} onAnalyze={checkPortfolio} error={error} portfolio={portfolio} parserSource={parserSource} />}
        {route === '/analysis' && policy && plan && <AnalysisPage policy={policy} results={results} previewResults={previewResults} plan={plan} onApprove={approvePlan} onBack={() => navigate('/')} />}
        {route === '/result' && policy && plan && <ResultPage plan={plan} results={previewResults} onComplete={completeMockExecution} onReset={resetFlow} onViewPortfolio={() => navigate('/')} />}
      </div>
      {isAnalyzing && <AnalysisTransition />}
      {notice && <div className="toast" role="status"><CircleAlert size={16} /> {notice}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={14} /></button></div>}
      <footer className="site-footer"><span><ShieldCheck size={14} /> Deterministic checks · Mock data only</span><span>Rokai v0.1 · Calm decisions by design</span></footer>
    </main>
  )
}

function Header({ route, onConnect }: { route: Route; onConnect: () => void }) {
  const steps = [{ route: '/', label: 'Set rules' }, { route: '/analysis', label: 'Review plan' }, { route: '/result', label: 'Verify' }]
  const goHome = () => { window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')) }
  return <header className="topbar">
    <button className="brand" type="button" onClick={goHome} aria-label="Return to Rokai home">
      <span className="brand-mark"><Command size={16} /></span><span className="brand-name">Rokai</span><span className="brand-rule" /><span className="brand-powered">Powered by Binance Agent OS</span>
    </button>
    <div className="journey-steps" aria-label="Flow progress">{steps.map((step, index) => <span className={step.route === route ? 'is-current' : steps.findIndex((item) => item.route === route) > index ? 'is-done' : ''} key={step.route}><i>{`0${index + 1}`}</i>{step.label}</span>)}</div>
    <div className="top-actions">
      <div className="mode-switch" aria-label="Current mode"><span className="mode-active"><i /> Mock</span><span className="mode-locked">Live <LockKeyhole size={11} /></span></div>
      <button className="connect-button" type="button" onClick={onConnect}>Connect Binance <ChevronRight size={14} /></button>
    </div>
  </header>
}

function LandingPage({ input, setInput, onAnalyze, error, portfolio, parserSource }: { input: string; setInput: (value: string) => void; onAnalyze: () => void; error: string; portfolio: ReturnType<typeof valuePortfolio>; parserSource: 'gemini' | 'fallback' | null }) {
  const examples = ['Keep 30% in USDC', 'Never sell BTC', 'No altcoin above 20%']
  return <>
    <section className="landing section-wrap">
      <div className="landing-copy">
        <div className="eyebrow"><Sparkles size={13} /> PORTFOLIO POLICY AGENT <span>01 / 03</span></div>
        <h1>Tell your portfolio<br /><em>what must stay true.</em></h1>
        <p className="lede">Set your rules in plain English. Rokai checks your portfolio and plans the smallest action needed to keep them true.</p>
        <div className="signal-line"><span /><b>CALM MODE ACTIVE</b><span /></div>
      </div>
      <div className="policy-panel">
        <div className="panel-top"><span className="panel-index">01</span><span className="panel-title">Your policy</span><span className="parser-badge"><ScanLine size={12} /> {parserSource === 'fallback' ? 'MOCK FALLBACK' : 'GEMINI PARSER'}</span></div>
        <label htmlFor="policy-input">What must stay true?</label>
        <textarea id="policy-input" value={input} onChange={(event) => setInput(event.target.value)} />
        <div className="policy-bottom">
          <div className="examples"><span>Try a rule</span>{examples.map((example) => <button key={example} type="button" onClick={() => setInput(example)}>{example}</button>)}</div>
          <button className="primary-cta" type="button" onClick={onAnalyze}>Analyze My Portfolio <ArrowUpRight size={17} /></button>
        </div>
        {error && <div className="inline-error"><CircleAlert size={15} /> {error}</div>}
      </div>
    </section>
    <PortfolioOverview portfolio={portfolio} />
  </>
}

function PortfolioOverview({ portfolio }: { portfolio: ReturnType<typeof valuePortfolio> }) {
  const colorMap: Record<string, string> = { USDC: 'mint', BTC: 'amber', ETH: 'blue', SOL: 'coral', BNB: 'yellow' }
  return <section className="portfolio section-wrap">
    <div className="section-kicker"><div><span className="eyebrow">02 / PORTFOLIO SNAPSHOT</span><h2>A clear view of what you hold.</h2></div><div className="data-stamp"><span><Database size={13} /> Mock fixture</span><span><Clock3 size={13} /> {fixtureTimestamp}</span></div></div>
    <div className="portfolio-head">
      <div><span className="micro-label">TOTAL VALUE</span><strong>{money.format(portfolio.totalUsd)}</strong><span className="portfolio-up"><ArrowUpRight size={13} /> +2.14% <small>this session</small></span></div>
      <div className="allocation-summary"><div className="micro-label">ALLOCATION MAP <span>5 assets</span></div><div className="allocation-bar">{portfolio.assets.map((asset) => <i className={`fill-${colorMap[asset.symbol]}`} style={{ width: `${asset.allocationPct}%` }} key={asset.symbol} />)}</div><div className="allocation-legend">{portfolio.assets.map((asset) => <span key={asset.symbol}><i className={`dot-${colorMap[asset.symbol]}`} />{asset.symbol} <b>{pct(asset.allocationPct)}</b></span>)}</div></div>
    </div>
    <div className="asset-grid">{portfolio.assets.map((asset) => <article className="asset-card" key={asset.symbol}><div className={`asset-accent accent-${colorMap[asset.symbol]}`} /><div className="asset-card-top"><span className={`asset-token token-${colorMap[asset.symbol]}`}>{asset.symbol === 'USDC' ? '$' : asset.symbol.slice(0, 1)}</span><span className="asset-change">{asset.change24h >= 0 ? '+' : ''}{asset.change24h.toFixed(2)}%</span></div><div className="asset-symbol">{asset.symbol}</div><div className="asset-name">{asset.name}</div><div className="asset-card-bottom"><strong>{money.format(asset.valueUsd)}</strong><span>{pct(asset.allocationPct)}</span></div><small>{asset.quantity < 1 ? asset.quantity.toFixed(4) : asset.quantity.toFixed(2)} {asset.symbol} · {moneyPrecise.format(asset.priceUsd)}</small></article>)}</div>
  </section>
}

function AnalysisPage({ policy, results, previewResults, plan, onApprove, onBack }: { policy: Policy; results: RuleResult[]; previewResults: RuleResult[]; plan: Plan; onApprove: () => void; onBack: () => void }) {
  const attentionCount = results.filter((result) => !result.passed).length
  const totalActionValue = plan.actions.reduce((sum, action) => sum + action.amountUsd, 0)
  const orderedResults = [...results].sort((a, b) => {
    const order = { min_stablecoin: 0, max_asset_exposure: 1, protected_asset: 2 }
    return order[a.rule.kind] - order[b.rule.kind]
  })
  return <section className="analysis section-wrap">
    <div className="analysis-top"><div><div className="eyebrow"><span className="eyebrow-signal" /> 02 / POLICY REVIEW</div><h1>{attentionCount} rules need attention<span className="title-period">.</span></h1><p>Rokai translated your policy and checked it against the mock portfolio.</p></div><div className="review-meta"><span className="review-pill"><span /> {results.length - attentionCount} satisfied</span><span className="review-time">Checked just now · fixture prices</span></div></div>
    <div className="rule-stack">{orderedResults.map((result, index) => <RuleReviewCard key={`${result.rule.kind}-${index}`} result={result} />)}</div>
    <section className="plan-section">
      <div className="plan-heading"><div><div className="eyebrow">03 / ROKAI’S PLAN</div><h2>The smallest compliant move.</h2></div><span className="plan-ready"><i /> READY FOR REVIEW</span></div>
      <div className="plan-layout">
        <div className="plan-main">
          <div className="plan-callout"><div className="plan-icon"><WalletCards size={22} /></div><div><span className="micro-label">RECOMMENDED ACTION</span><h3>{plan.safe && plan.actions.length ? `Sell ${moneyPrecise.format(totalActionValue)} into USDC` : 'Unable to plan safely'}</h3><p>{plan.safe && plan.actions.length ? `${plan.actions.length} conversion${plan.actions.length === 1 ? '' : 's'} restore all active constraints without touching protected assets.` : 'Rokai will not propose an incomplete or unsafe action.'}</p></div></div>
          {plan.actions.length > 0 && <div className="conversion-list">{plan.actions.map((action) => <div className="conversion-row" key={`${action.source}-${action.amountUsd}`}><div className="conversion-route"><span className={`asset-token token-${action.source.toLowerCase()}`}>{action.source.slice(0, 1)}</span><ArrowRight size={14} /><span className="asset-token token-mint">$</span></div><div><b>{action.source} <span>→</span> USDC</b><small>{action.rationale}</small></div><strong>{moneyPrecise.format(action.amountUsd)}</strong></div>)}</div>}
          <BeforeAfter results={orderedResults} previewResults={previewResults} />
        </div>
        <aside className="approval-card"><div className="agent-mark"><span><Command size={18} /></span><div><b>Binance Agent OS</b><small>Mock execution adapter</small></div></div><div className="approval-rule" /><div className="approval-copy"><span className="micro-label">APPROVAL GATE</span><p>Review the exact conversions before anything is simulated.</p></div><button className="agent-cta" type="button" onClick={onApprove} disabled={!plan.safe || !plan.actions.length}>Enforce with Agent OS <ArrowUpRight size={16} /></button><div className="nothing-changes"><LockKeyhole size={13} /> Nothing changes without your approval.</div></aside>
      </div>
      {plan.warnings.map((warning) => <div className="plan-warning" key={warning}><CircleAlert size={15} /> {warning}</div>)}
      <div className="plan-foot"><span><Check size={14} /> One reviewed plan satisfies all {policy.rules.length} active rules.</span><button className="back-link" type="button" onClick={onBack}>Edit policy <ArrowRight size={14} /></button></div>
    </section>
  </section>
}

function RuleReviewCard({ result }: { result: RuleResult }) {
  const isProtected = result.rule.kind === 'protected_asset'
  return <article className={`rule-review-card ${result.passed ? 'passed' : 'attention'}`}><div className="rule-card-index">{`0${result.rule.kind === 'min_stablecoin' ? 1 : result.rule.kind === 'protected_asset' ? 3 : 2}`}</div><div className="rule-card-main"><div className="rule-card-heading"><h2>{ruleTitle(result)}</h2><span className={`status-tag ${result.passed ? 'status-pass' : 'status-attention'}`}>{result.passed ? <CircleCheck size={14} /> : <CircleAlert size={14} />} {result.passed ? 'Satisfied' : 'Needs attention'}</span></div><p>{result.detail}</p></div><div className="rule-number"><span>{isProtected ? 'Protected' : pct(result.currentPct ?? 0)}</span><small>{isProtected ? 'BTC untouched' : ruleTarget(result)}</small></div><div className="rule-arrow">{result.passed ? <Check size={17} /> : <ArrowDownRight size={17} />}</div></article>
}

function BeforeAfter({ results, previewResults }: { results: RuleResult[]; previewResults: RuleResult[] }) {
  const comparison = results.filter((result) => result.rule.kind !== 'protected_asset')
  return <div className="before-after"><div className="before-after-head"><span className="micro-label">COMPLIANCE PREVIEW</span><span><i /> protected assets stay untouched</span></div><div className="comparison-grid"><div className="comparison-column"><span className="comparison-label">BEFORE</span>{comparison.map((result) => <div className="comparison-value" key={result.rule.kind}><b>{ruleTitle(result).replace(' Reserve', '').replace(' Exposure', '')}</b><strong>{pct(result.currentPct ?? 0)}</strong></div>)}</div><div className="comparison-divider"><ArrowRight size={17} /></div><div className="comparison-column after"><span className="comparison-label">AFTER SIMULATION</span>{comparison.map((result) => { const after = previewResults.find((item) => item.rule.kind === result.rule.kind); return <div className="comparison-value" key={result.rule.kind}><b>{ruleTitle(result).replace(' Reserve', '').replace(' Exposure', '')}</b><strong>{pct(after?.currentPct ?? 0)} <Check size={13} /></strong></div> })}</div></div><div className="untouched"><LockKeyhole size={13} /> BTC untouched · no protected asset is included in the plan</div></div>
}

function ResultPage({ plan, results, onComplete, onReset, onViewPortfolio }: { plan: Plan; results: RuleResult[]; onComplete: () => void; onReset: () => void; onViewPortfolio: () => void }) {
  const [completedCount, setCompletedCount] = useState(0)
  const [complete, setComplete] = useState(false)
  const stages = ['Checking permissions…', 'Preparing action…', 'Executing through Binance Agent OS…', 'Verifying updated portfolio…']

  useEffect(() => {
    const timers = stages.map((_, index) => window.setTimeout(() => setCompletedCount(index + 1), 180 + index * 190))
    const finish = window.setTimeout(() => { onComplete(); setComplete(true) }, 980)
    return () => { timers.forEach((timer) => window.clearTimeout(timer)); window.clearTimeout(finish) }
  }, [onComplete])

  if (!complete) return <section className="execution section-wrap"><div className="execution-intro"><div className="eyebrow"><RefreshCw className="spin" size={13} /> 03 / MOCK EXECUTION</div><h1>Keeping your rules<br /><em>in the loop.</em></h1><p>Rokai is moving through the approval-gated sequence. No live account is connected.</p></div><div className="execution-card">{stages.map((stage, index) => <div className={`execution-step ${index < completedCount ? 'done' : index === completedCount ? 'current' : ''}`} key={stage}><span className="step-mark">{index < completedCount ? <Check size={15} /> : index === completedCount ? <RefreshCw className="spin" size={14} /> : <i />}</span><div><b>{stage}</b><small>{index < completedCount ? 'Complete' : index === completedCount ? 'In progress' : 'Queued'}</small></div><span className="step-line" /></div>)}<div className="mock-execution-note"><span><Command size={15} /> Binance Agent OS</span><span>Mock Mode · simulated only</span></div></div></section>

  const stableResult = results.find((result) => result.rule.kind === 'min_stablecoin')
  const maxResult = results.find((result) => result.rule.kind === 'max_asset_exposure')
  const protectedResult = results.find((result) => result.rule.kind === 'protected_asset')
  return <section className="success section-wrap"><div className="success-eyebrow"><span className="success-seal"><CircleCheck size={19} /></span><span>VERIFIED · MOCK MODE</span></div><h1>Rules <em>restored.</em></h1><p className="success-copy">Your portfolio now satisfies all active rules.</p><div className="verified-grid"><div><span>USDC reserve</span><strong>{pct(stableResult?.currentPct ?? 0)} <Check size={17} /></strong></div><div><span>{maxResult ? ruleTitle(maxResult) : 'Altcoin exposure'}</span><strong>{pct(maxResult?.currentPct ?? 0)} <Check size={17} /></strong></div><div><span>BTC protection</span><strong>{protectedResult?.passed ? 'Untouched' : 'Review'} <Check size={17} /></strong></div></div><div className="success-meta"><span><Check size={14} /> Balances refreshed</span><span><Check size={14} /> Policy rechecked</span><span><Clock3 size={14} /> Just now · mock fixture</span></div><div className="success-actions"><button className="primary-cta" type="button" onClick={onReset}>Set New Rules <ArrowUpRight size={17} /></button><button className="secondary-cta" type="button" onClick={onViewPortfolio}>View Portfolio <ArrowRight size={16} /></button></div></section>
}

function AnalysisTransition() {
  return <div className="transition-screen" role="status" aria-live="polite"><div className="transition-orbit"><ScanLine size={22} /></div><span>ROKAI IS CHECKING</span><strong>Reading your constraints<span className="ellipsis">…</span></strong><small>Mock portfolio · deterministic checks</small></div>
}

export default App
