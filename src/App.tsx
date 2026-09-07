import {
  ArrowRight,
  Check,
  ChevronRight,
  Command,
  Eye,
  LockKeyhole,
  Network,
  Scale,
  ShieldCheck,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react'

const supportedRules = [
  { number: '01', title: 'Minimum stablecoin allocation', example: 'Keep at least 40% in USDC.' },
  { number: '02', title: 'Protected assets', example: 'Never sell BTC.' },
  { number: '03', title: 'Maximum asset exposure', example: 'No altcoin above 20%.' },
  { number: '04', title: 'Minimum stablecoin amount', example: 'Always keep at least 1,000 USDC.' },
  { number: '05', title: 'Minimum asset allocation', example: 'Keep at least 20% in BTC.' },
]

const workflow = [
  { number: '01', title: 'Read', copy: 'Use Binance Agent OS to read Spot balances and the prices needed to value them.' },
  { number: '02', title: 'Interpret', copy: 'Turn plain-English policy into one of five explicit, reviewable rule types.' },
  { number: '03', title: 'Evaluate', copy: 'Run deterministic portfolio math to find exactly what is satisfied or broken.' },
  { number: '04', title: 'Plan', copy: 'Calculate the smallest reasonable corrective action without touching protected assets.' },
  { number: '05', title: 'Approve', copy: 'Show the exact asset, side, amount, and expected before → after result.' },
  { number: '06', title: 'Execute → Verify', copy: 'After approval, use sanctioned Spot tools, then reread and recalculate everything.' },
]

function App() {
  return (
    <main className="landing-shell">
      <div className="landing-grid" aria-hidden="true" />

      <header className="landing-header">
        <a className="landing-brand" href="#top" aria-label="Rokai home">
          <span className="brand-mark"><Command size={16} strokeWidth={2.4} /></span>
          <span>Rokai</span>
        </a>
        <div className="header-meta">
          <span><Sparkles size={13} /> Binance Agent OS skill</span>
          <span className="status-pill"><i /> Read-only demo</span>
        </div>
      </header>

      <section className="hero section" id="top">
        <div className="hero-copy reveal-item">
          <p className="eyebrow"><span className="eyebrow-line" /> PORTFOLIO POLICY AGENT</p>
          <h1>AI that follows your rules, <em>not the market hype.</em></h1>
          <p className="hero-lede">Rokai turns a plain-English portfolio policy into a deterministic, reviewable action plan for Binance Agent OS.</p>
          <div className="hero-actions">
            <a className="primary-link" href="#workflow">See the workflow <ArrowRight size={16} /></a>
            <a className="quiet-link" href="#skill">Read the skill <ChevronRight size={15} /></a>
          </div>
          <p className="host-note"><Terminal size={14} /> Rokai runs as an Agent OS skill inside supported hosts such as Codex.</p>
        </div>

        <div className="policy-demo reveal-item reveal-delay-1" aria-label="Rokai policy check example">
          <div className="demo-topline"><span>ROKAI POLICY CHECK</span><span className="demo-source"><i /> CODEX SESSION</span></div>
          <div className="demo-policy">“Keep at least 40% in USDC, never sell BTC, and don’t let any altcoin exceed 20%.”</div>
          <div className="demo-rule-list">
            <div className="demo-rule"><span className="rule-state is-good"><Check size={12} /></span><div><strong>BTC Protection</strong><small>Protected from selling</small></div><b>SATISFIED</b></div>
            <div className="demo-rule"><span className="rule-state is-alert">×</span><div><strong>USDC Reserve</strong><small>Current 24% · Required ≥ 40%</small></div><b>ATTENTION</b></div>
            <div className="demo-rule"><span className="rule-state is-alert">×</span><div><strong>SOL Exposure</strong><small>Current 31% · Maximum 20%</small></div><b>ATTENTION</b></div>
          </div>
          <div className="demo-plan">
            <div className="demo-plan-heading"><span>PROPOSED ACTION</span><span>1 ACTION</span></div>
            <strong>Sell $800 SOL <i>→</i> USDC</strong>
            <p>Smallest corrective action. BTC remains untouched.</p>
            <div className="demo-after"><span>Expected result</span><b>USDC 40.1% <Check size={13} /></b><b>SOL 19.9% <Check size={13} /></b></div>
          </div>
          <div className="demo-approval"><LockKeyhole size={14} /> Approval is required before any state-changing action.</div>
        </div>
      </section>

      <section className="intro-band section reveal-item" id="skill">
        <div className="section-label"><span>01</span><span>THE IDEA</span></div>
        <div className="intro-content">
          <h2>A policy layer for agents that act on your portfolio.</h2>
          <p>Trading agents chase signals. Research agents explain markets. Rokai does something narrower and more accountable: it keeps a user-defined portfolio policy visible, measurable, and subject to approval.</p>
          <div className="principles">
            <div><Eye size={17} /><strong>Readable</strong><span>Every rule and proposed action is shown plainly.</span></div>
            <div><Scale size={17} /><strong>Deterministic</strong><span>Portfolio math and trade sizing stay in Rokai code.</span></div>
            <div><ShieldCheck size={17} /><strong>Guarded</strong><span>No action happens without explicit approval.</span></div>
          </div>
        </div>
      </section>

      <section className="workflow-section section" id="workflow">
        <div className="section-heading reveal-item"><div className="section-label"><span>02</span><span>THE WORKFLOW</span></div><h2>From intent to verified state.</h2><p>One calm sequence. No chat maze, no freestyle portfolio math.</p></div>
        <div className="workflow-list">
          {workflow.map((item, index) => <article className={`workflow-card reveal-item reveal-delay-${Math.min(index + 1, 3)}`} key={item.number}>
            <span className="workflow-number">{item.number}</span><div><h3>{item.title}</h3><p>{item.copy}</p></div>
          </article>)}
        </div>
      </section>

      <section className="architecture-section section reveal-item" id="architecture">
        <div className="section-label"><span>03</span><span>AGENT-FIRST ARCHITECTURE</span></div>
        <div className="architecture-copy"><h2>The website explains Rokai.<br /><em>The skill does the work.</em></h2><p>Rokai is designed to run inside a supported Agent OS host such as Codex, where Binance authorization and MCP access are already part of the host environment.</p></div>
        <div className="architecture-flow" aria-label="Rokai architecture">
          <div><span className="flow-icon"><Command size={17} /></span><b>User</b><small>Sets the rule</small></div><i /><div><span className="flow-icon"><Zap size={17} /></span><b>Rokai Skill</b><small>Checks & plans</small></div><i /><div><span className="flow-icon"><Network size={17} /></span><b>Supported Host</b><small>Codex or similar</small></div><i /><div><span className="flow-icon"><LockKeyhole size={17} /></span><b>Binance Agent OS / MCP</b><small>Agentic account</small></div>
        </div>
      </section>

      <section className="rules-section section" id="rules">
        <div className="section-heading reveal-item"><div className="section-label"><span>04</span><span>SUPPORTED MVP RULES</span></div><h2>Small rule set. Clear behavior.</h2></div>
        <div className="rules-grid">{supportedRules.map((rule, index) => <article className={`rule-card reveal-item reveal-delay-${Math.min(index + 1, 3)}`} key={rule.number}><span>{rule.number}</span><h3>{rule.title}</h3><p>{rule.example}</p></article>)}</div>
      </section>

      <section className="safety-section section reveal-item">
        <div className="safety-callout"><div className="section-label"><span>05</span><span>SAFETY MODEL</span></div><div><h2>Read first. Ask clearly. Act only with approval.</h2><p>Gemini interprets language only. Rokai owns the calculations. Binance Agent OS supplies account and market data. The current demo does not execute real trades.</p></div></div>
        <div className="safety-list"><span><Check size={14} /> No invented balances or prices</span><span><Check size={14} /> Protected assets stay protected</span><span><Check size={14} /> No withdrawals or transfers</span></div>
      </section>

      <section className="closing-section section reveal-item">
        <p className="eyebrow"><span className="eyebrow-line" /> CURRENTLY AGENT-FIRST</p>
        <h2>Give your portfolio<br /><em>rules it can keep.</em></h2>
        <p>Read the full workflow in <code>SKILL.md</code>, then load it in a supported Agent OS host.</p>
        <a className="primary-link" href="#workflow">Explore Rokai <ArrowRight size={16} /></a>
      </section>

      <footer className="landing-footer"><span><Command size={14} /> Rokai · AI that follows your rules, not the market hype.</span><span>Public explainer · No direct Binance login on this site</span></footer>
    </main>
  )
}

export default App
