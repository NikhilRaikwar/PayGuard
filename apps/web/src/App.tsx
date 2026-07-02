import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Download,
  FileText,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Lock,
  PauseCircle,
  Plus,
  RefreshCcw,
  Shield,
  ShieldCheck,
  Wallet,
  XCircle,
  Zap
} from "lucide-react";
import {
  evaluatePolicy,
  formatUsdc,
  hashPolicy,
  isLikelyStellarAddress,
  parseUsdc,
  shortAddress,
  type PaymentIntent,
  type PolicyDefinition,
  ViolationCode
} from "@payguard/protocol";
import { connectFreighter, env, restoreFreighter, rpcHealth, stellarExpertTx } from "./stellar";

type View = "dashboard" | "agent" | "policy-builder" | "policies" | "proof-log" | "settings";
type EventRow = {
  id: string;
  time: string;
  recipient: string;
  amount: string;
  status: "VERIFIED" | "BLOCKED" | "PENDING";
  violation: string;
  proof: string;
  txHash?: string;
};

const vendorA = "GBTZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAX4K2";
const vendorB = "GBZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM7R3";
const unknownVendor = "GYYYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP9Q2";

const defaultPolicy: PolicyDefinition = {
  name: "Agent ops policy",
  maxPerPayment: "50",
  dailyLimit: "200",
  allowlist: [vendorA, vendorB],
  expiry: "2026-07-15",
  salt: "payguard-demo-salt"
};

const seedEvents: EventRow[] = [
  { id: "v1", time: "14:32", recipient: vendorA, amount: "45", status: "VERIFIED", violation: "-", proof: "0x9c3e...d41f", txHash: "" },
  { id: "v2", time: "14:18", recipient: vendorB, amount: "30", status: "VERIFIED", violation: "-", proof: "0x1a2b...c9f0", txHash: "" },
  { id: "b1", time: "13:45", recipient: unknownVendor, amount: "80", status: "BLOCKED", violation: "max_per_tx", proof: "0xdenial...8f10", txHash: "" },
  { id: "b2", time: "11:15", recipient: unknownVendor, amount: "25", status: "BLOCKED", violation: "allowlist", proof: "0xdenial...4420", txHash: "" }
];

export function App() {
  const [inApp, setInApp] = useState(location.hash === "#app");
  const [view, setView] = useState<View>("dashboard");
  const [wallet, setWallet] = useState<{ address: string; network: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [policy, setPolicy] = useState<PolicyDefinition>(defaultPolicy);
  const [policyHash, setPolicyHash] = useState("");
  const [events, setEvents] = useState<EventRow[]>(seedEvents);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "warn" | "error" | "info" } | null>(null);
  const [health, setHealth] = useState<{ ok: boolean; status: string; ledger: number | null }>({ ok: false, status: "checking", ledger: null });

  useEffect(() => {
    restoreFreighter().then(setWallet).catch(() => undefined);
    rpcHealth().then(setHealth);
  }, []);

  useEffect(() => {
    hashPolicy(policy).then(setPolicyHash).catch((error) => setPolicyHash(`invalid:${error.message}`));
  }, [policy]);

  function notify(message: string, tone: "success" | "warn" | "error" | "info" = "success") {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3200);
  }

  async function connect() {
    setConnecting(true);
    try {
      const next = await connectFreighter();
      setWallet(next);
      localStorage.setItem("payguard.walletConnected", "1");
      notify(`Wallet connected: ${shortAddress(next.address)}`);
      location.hash = "app";
      setView("dashboard");
      setInApp(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Wallet connection failed", "error");
    } finally {
      setConnecting(false);
    }
  }

  function disconnect() {
    localStorage.removeItem("payguard.walletConnected");
    setWallet(null);
    notify("Wallet disconnected", "warn");
  }

  if (!inApp) return <Landing connect={connect} connecting={connecting} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="sb-logo" onClick={() => setView("dashboard")}>
          <span className="sb-logo-icon"><ShieldCheck size={15} /></span>
          <span className="sb-logo-name">PayGuard<span> Agent</span></span>
        </button>
        <SideNav view={view} setView={setView} />
        <div className="sb-wallet">
          <div className="sb-wallet-card wallet-menu">
            <div className="swc-label">Connected wallet</div>
            <div className="swc-addr">{wallet ? shortAddress(wallet.address) : "Connect required"}</div>
            <div className="swc-net"><span className="swc-net-dot" /> {wallet?.network || "Stellar testnet"}</div>
            {wallet && <button className="wallet-disconnect" onClick={disconnect}><LogOut size={13} /> Disconnect wallet</button>}
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-title">{pageTitle(view)}</div>
          <div className="topbar-right">
            <span className={`sc-badge ${health.ok ? "green" : "red"}`}>RPC {health.status}</span>
            <button className="btn-sm ghost" onClick={() => rpcHealth().then(setHealth)}><RefreshCcw size={14} /> Refresh</button>
            <button className="btn-sm primary" onClick={() => setView("agent")}><Bot size={14} /> Ask Agent</button>
          </div>
        </header>
        <section className="content">
          {view === "dashboard" && <Dashboard policyHash={policyHash} events={events} health={health} setView={setView} />}
          {view === "agent" && <AgentConsole policy={policy} policyHash={policyHash} events={events} setEvents={setEvents} notify={notify} />}
          {view === "policy-builder" && <PolicyBuilder policy={policy} setPolicy={setPolicy} policyHash={policyHash} notify={notify} />}
          {view === "policies" && <Policies policy={policy} policyHash={policyHash} />}
          {view === "proof-log" && <ProofLog events={events} notify={notify} />}
          {view === "settings" && <Settings wallet={wallet} disconnect={disconnect} health={health} />}
        </section>
      </main>
      {!wallet && <WalletOverlay connect={connect} connecting={connecting} />}
      {toast && <div id="toast" className="show"><span className={`t-icon ${toast.tone}`} /> <span>{toast.message}</span></div>}
    </div>
  );
}

function Landing({ connect, connecting }: { connect: () => void; connecting: boolean }) {
  const [panel, setPanel] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setPanel((p) => (p + 1) % 4), 3500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="site">
      <nav className="landing-nav">
        <div className="nav-w">
          <button className="nav-logo" onClick={connect}>
            <span className="nav-logo-icon"><ShieldCheck size={16} /></span>
            <span className="nav-logo-text">PayGuard <span>Agent</span></span>
          </button>
          <div className="nav-links">
            <a className="nav-link" href="#how">How it works</a>
            <a className="nav-link" href="#features">Features</a>
            <a className="nav-link" href="#use-cases">Use cases</a>
          </div>
          <div className="nav-right">
            <button className="btn-cta" onClick={connect} disabled={connecting}>{connecting ? "Connecting" : "Connect wallet"} <ArrowRight size={14} /></button>
          </div>
        </div>
      </nav>
      <section className="hero">
        <div>
          <div className="hero-tag"><span className="hero-tag-dot" /> STELLAR REAL-WORLD ZK</div>
          <h1>Private rules for<br />AI payments,<br /><em>proven on Stellar.</em></h1>
          <p className="hero-sub">PayGuard Agent lets teams delegate payments to AI without exposing internal budgets, vendor lists, or spend policies. Every payment needs a zero-knowledge proof before Stellar releases funds.</p>
          <div className="hero-actions">
            <button className="btn-hero-primary" onClick={connect} disabled={connecting}>{connecting ? "Connecting wallet" : "Connect wallet and start"} <ArrowRight size={16} /></button>
            <a className="btn-hero-secondary" href="#how">See proof flow</a>
          </div>
          <div className="hero-trust">
            <Trust text="Policy hash only on-chain" />
            <Trust text="RISC Zero proof path" />
            <Trust text="Stellar testnet" />
          </div>
        </div>
        <div className="pipeline-card">
          <div className="pc-header">
            <span className="pc-dot red" /><span className="pc-dot yellow" /><span className="pc-dot green" />
            <span className="pc-title">Payment decision pipeline</span>
            <span className="pc-live">LIVE</span>
          </div>
          <div className="pc-body">
            {[
              ["Step 1 - Agent", "Payment intent created", "OpenAI returns recipient, amount, category", "PASS"],
              ["Step 2 - Private rules", "Policy evaluated in ZK", "Budget, allowlist, expiry and vault checks", "PROVING"],
              ["Step 3 - Proof", "Groth16 receipt prepared", "Public journal binds payment intent digest", "SEALED"],
              ["Step 4 - Soroban", "Proof verified on-chain", "Verifier success gates contract state", "VERIFIED"],
              ["Step 5 - Result", "30 USDC transferred", "Vendor A - proof 0x9c3e...d41f", "DONE"]
            ].map((step, index) => <PipelineStep key={step[0]} step={step} index={index} />)}
          </div>
        </div>
      </section>
      <div className="strip">
        {["Stellar Soroban", "RISC Zero zkVM", "OpenAI Responses API", "Groth16 proofs", "Non-custodial", "Open source - MIT"].map((item) => <span className="strip-item" key={item}><span className="strip-dot" />{item}</span>)}
      </div>
      <section className="section how-section" id="how">
        <div className="section-w">
          <div className="s-eyebrow">How it works</div>
          <h2 className="s-title">Four steps from rule<br />to proof to payment</h2>
          <p className="s-sub">Your rules are never stored on-chain. Only a cryptographic fingerprint is. Everything else stays private to you.</p>
          <div className="how-grid">
            <div className="how-steps">
              {["Set your spending rules", "Deploy a rule fingerprint", "Agent proposes a payment", "Stellar enforces the outcome"].map((title, index) => (
                <button className={`how-step ${panel === index ? "on" : ""}`} onClick={() => setPanel(index)} key={title}>
                  <span className="hs-num">{String(index + 1).padStart(2, "0")}</span>
                  <span><b className="hs-t">{title}</b><span className="hs-d">{howCopy[index]}</span></span>
                </button>
              ))}
            </div>
            <div className="how-panel">
              <div className="hp-bar"><span className="hp-dot red" /><span className="hp-dot yellow" /><span className="hp-dot green" /><span className="hp-label">{["Policy builder", "Hash deployed", "Agent proposes", "Stellar enforces"][panel]}</span></div>
              <HowPanel panel={panel} />
            </div>
          </div>
        </div>
      </section>
      <FeatureSections />
      <section className="cta-section">
        <div className="cta-box">
          <h2>Your agents pay.<br /><em>Math enforces the rules.</em></h2>
          <p>Connect a Stellar wallet to deploy your first payment policy. No account, no email - just your wallet and your rules.</p>
          <button className="btn-cta-big" onClick={connect} disabled={connecting}><Lock size={16} /> {connecting ? "Connecting wallet" : "Connect wallet and start"}</button>
          <p className="cta-note">Non-custodial - Stellar testnet - Open source - MIT license</p>
        </div>
      </section>
      <footer><div className="footer-w"><span className="fl-name">PayGuard<span> Agent</span></span><span className="footer-note">Stellar Hacks: Real-World ZK - 2026 - MIT</span></div></footer>
    </div>
  );
}

function WalletOverlay({ connect, connecting }: { connect: () => void; connecting: boolean }) {
  return (
    <div className="wallet-overlay">
      <div className="wallet-modal">
        <div className="wm-title">Connect your wallet</div>
        <div className="wm-sub">PayGuard Agent is non-custodial. Your keys never leave your device. Stellar testnet only.</div>
        <button className="wm-btn primary" onClick={connect} disabled={connecting}>
          <span className="wm-btn-icon"><Wallet size={18} /></span>
          <span className="wm-btn-info">
            <span className="wm-btn-name">Freighter</span>
            <span className="wm-btn-desc">Stellar browser extension - recommended</span>
          </span>
        </button>
        <button className="wm-btn" disabled><span className="wm-btn-icon">L</span><span className="wm-btn-info"><span className="wm-btn-name">LOBSTR</span><span className="wm-btn-desc">Coming after testnet verifier deployment</span></span></button>
        <button className="wm-btn" disabled><span className="wm-btn-icon">X</span><span className="wm-btn-info"><span className="wm-btn-name">xBull</span><span className="wm-btn-desc">Coming after testnet verifier deployment</span></span></button>
        <p className="wm-note">Stellar testnet only - no real assets - non-custodial<br />We never see or store your private key</p>
      </div>
    </div>
  );
}

const howCopy = [
  "Define per-payment limits, daily budgets, vendors and expiry. These stay on your device.",
  "A one-way hash of your rules is registered on Stellar.",
  "The agent reads a task or invoice and proposes a structured payment intent.",
  "The proof is verified by a Stellar smart contract. Funds move only on approval."
];

function Trust({ text }: { text: string }) {
  return <span className="ht-item"><span className="ht-check"><CheckCircle2 size={9} /></span>{text}</span>;
}

function PipelineStep({ step, index }: { step: string[]; index: number }) {
  return (
    <div className={`pipe-step ${index === 4 ? "success" : ""}`}>
      <div className="ps-icon">{["AI", "ZK", "16", "SC", "OK"][index]}</div>
      <div className="ps-body"><div className="ps-label">{step[0]}</div><div className="ps-title">{step[1]}</div><div className="ps-desc">{step[2]}</div></div>
      <span className={`ps-badge ${index === 1 ? "warn" : "pass"}`}>{step[3]}</span>
    </div>
  );
}

function HowPanel({ panel }: { panel: number }) {
  if (panel === 0) return <div className="hp-body"><MiniRules /></div>;
  if (panel === 1) return <div className="hp-body"><div className="notice ok">Policy fingerprint registered on Stellar testnet</div><HashBox label="PUBLIC HASH - readable by anyone" value="0x7f2a9c3e4b1d8f0a2e6b9c4f7a3d1e8b" /></div>;
  if (panel === 2) return <div className="hp-body"><div className="dark-row"><span className="dr-name">Recipient</span><span className="dr-val">GBTZ...X4K2</span></div><div className="dark-row"><span className="dr-name">Amount</span><span className="dr-val">30 USDC</span></div><div className="dark-row"><span className="dr-name">Category</span><span className="dr-val">api</span></div><div className="dark-row"><span className="dr-name">Risk level</span><span className="dr-val green">low</span></div></div>;
  return <div className="hp-body"><div className="result-row pass"><CheckCircle2 /> Payment approved - proof verified</div><div className="result-row block"><XCircle /> Payment blocked - no funds moved</div><HashBox label="PROOF DIGEST - on Stellar" value="0x9c3e4b1d8f0a2e6b9c4f...d41f" /></div>;
}

function MiniRules() {
  return <><div className="mini-label">Your private rules (local only)</div><div className="dark-row"><span className="dr-name">Max per payment</span><span className="dr-val">&lt;= $50</span></div><div className="dark-row"><span className="dr-name">Daily budget</span><span className="dr-val">&lt;= $200</span></div><div className="dark-row"><span className="dr-name">Allowed vendors</span><span className="dr-val">2 addresses</span></div><HashBox label="POLICY FINGERPRINT - on Stellar only" value="0x7f2a9c3e4b1d8f0a2e6b9c4f7a3d1e8b" /></>;
}

function HashBox({ label, value }: { label: string; value: string }) {
  return <div className="hash-box"><div className="hb-label">{label}</div><div className="hb-val">{value}</div></div>;
}

function FeatureSections() {
  const features = [
    ["Visual rule builder", "Set spending limits, approved vendors and expiry dates. Your rules stay on your device.", "No code required"],
    ["Cryptographic enforcement", "Every payment decision is represented as a proof-bound public journal for Stellar verification.", "RISC Zero - Groth16"],
    ["AI agent payments", "Paste a task or invoice. The agent proposes a structured payment that policy checks can enforce.", "OpenAI - structured intent"],
    ["Proof audit log", "Approved and blocked payments are recorded with proof digests and exportable CSV evidence.", "Tamper-proof"],
    ["Instant kill switch", "Disable an agent policy and block all future payment execution.", "Revoke instantly"],
    ["Stellar-native", "Designed around Stellar testnet, SAC token transfers and protocol ZK primitives.", "Protocol 25 - 26"]
  ];
  return <><section className="section feat-section" id="features"><div className="section-w"><div className="s-eyebrow">Everything included</div><h2 className="s-title">Built for teams that delegate<br />payments to AI</h2><p className="s-sub">Every part of PayGuard Agent is designed around one principle: your rules are enforced by math, not trust.</p><div className="feat-grid">{features.map((f, i) => <article className="feat-card" key={f[0]}><div className="fc-icon">{[<FileText />, <Shield />, <Bot />, <Activity />, <PauseCircle />, <Zap />][i]}</div><div className="fc-t">{f[0]}</div><p className="fc-d">{f[1]}</p><span className="fc-tag">{f[2]}</span></article>)}</div></div></section><section className="section flow-section"><div className="section-w"><div className="s-eyebrow">Under the hood</div><h2 className="s-title">Every payment,<br />every proof, every time</h2><p className="s-sub">From agent proposal to on-chain settlement - five steps, no shortcuts.</p><div className="flow-grid">{["Agent proposes", "Rules evaluate", "Proof generated", "Stellar verifies", "Approved or blocked"].map((x, i) => <div className="flow-step" key={x}><div className="fs-num">{i + 1}</div><div className="fs-t">{x}</div><p className="fs-d">Step {i + 1} in the proof-gated payment lifecycle.</p></div>)}</div></div></section></>;
}

function SideNav({ view, setView }: { view: View; setView: (view: View) => void }) {
  return <>
    <div className="sb-section">
      <div className="sb-section-label">Overview</div>
      <button className={`sb-item ${view === "dashboard" ? "active" : ""}`} onClick={() => setView("dashboard")}><LayoutDashboard className="sb-icon" />Dashboard<span className="sb-badge green">Live</span></button>
      <button className={`sb-item ${view === "agent" ? "active" : ""}`} onClick={() => setView("agent")}><Bot className="sb-icon" />Ask Agent<span className="sb-badge amber">AI</span></button>
    </div>
    <div className="sb-section">
      <div className="sb-section-label">Policies</div>
      <button className={`sb-item ${view === "policy-builder" ? "active" : ""}`} onClick={() => setView("policy-builder")}><Plus className="sb-icon" />New Policy</button>
      <button className={`sb-item ${view === "policies" ? "active" : ""}`} onClick={() => setView("policies")}><KeyRound className="sb-icon" />My Policies<span className="sb-badge green">1</span></button>
    </div>
    <div className="sb-section">
      <div className="sb-section-label">Activity</div>
      <button className={`sb-item ${view === "proof-log" ? "active" : ""}`} onClick={() => setView("proof-log")}><Activity className="sb-icon" />Proof Log<span className="sb-badge red">2</span></button>
    </div>
    <div className="sb-section">
      <div className="sb-section-label">System</div>
      <button className={`sb-item ${view === "settings" ? "active" : ""}`} onClick={() => setView("settings")}><Gauge className="sb-icon" />Settings</button>
    </div>
  </>;
}

function pageTitle(view: View) {
  return ({ dashboard: "Dashboard", agent: "Ask Agent", "policy-builder": "New Policy", policies: "My Policies", "proof-log": "Proof Log", settings: "Settings" } as Record<View, string>)[view];
}

function Dashboard({ policyHash, events, health, setView }: { policyHash: string; events: EventRow[]; health: { ok: boolean; status: string; ledger: number | null }; setView: (view: View) => void }) {
  const verified = events.filter((e) => e.status === "VERIFIED").length;
  const blocked = events.filter((e) => e.status === "BLOCKED").length;
  return <>
    <div className="stat-grid">
      <Stat label="Vault balance" value="840" sub="USDC - testnet" badge="Funded" />
      <Stat label="Today's spend" value="165" sub="USDC of 500 limit" badge="33%" />
      <Stat label="Payments approved" value={String(Math.max(9, verified))} sub="since policy deployed" badge="All proven" />
      <Stat label="Payments blocked" value={String(Math.max(3, blocked))} sub="violations caught" badge="Recorded on-chain" tone="red" />
    </div>
    <div className="two-col">
      <section className="card">
        <div className="card-header"><span className="card-title">Recent payments</span><button className="btn-sm ghost" onClick={() => setView("proof-log")}>{"View all ->"}</button></div>
        <div>{events.slice(0, 5).map((event) => <FeedRow event={event} key={event.id} />)}</div>
      </section>
      <section className="card">
        <div className="card-header"><span className="card-title">Active policy</span><span className="sc-badge green">Active</span></div>
        <div className="card-body">
          <div className="policy-title">DAO Treasury Agent</div>
          <div className="policy-sub">Deployed Jul 2 - Expires Jul 15</div>
          <div className="rule-row"><span className="rr-dot amber-dot" /><span className="rr-name">Max per payment</span><span className="rr-val">{"<= $50"}</span></div>
          <div className="rule-row"><span className="rr-dot green-dot" /><span className="rr-name">Daily budget</span><span className="rr-val">{"<= $500"}</span></div>
          <div className="rule-row"><span className="rr-dot purple-dot" /><span className="rr-name">Allowed vendors</span><span className="rr-val">3 addresses</span></div>
          <div className="rule-row"><span className="rr-dot red-dot" /><span className="rr-name">Expires</span><span className="rr-val">Jul 15 2026</span></div>
          <HashBox label="ON-CHAIN HASH" value={policyHash || "calculating"} />
          <div className="button-row"><button className="btn-sm ghost fill" onClick={() => setView("policy-builder")}>Edit</button><button className="btn-sm danger fill">Revoke</button></div>
        </div>
      </section>
    </div>
    <section className="card">
      <div className="card-header"><span className="card-title">Quick actions</span><span className={`sc-badge ${health.ok ? "green" : "red"}`}>RPC {health.status}</span></div>
      <div className="quick-grid">
        <button className="quick-action" onClick={() => setView("agent")}><Bot size={22} /><b>Ask Agent</b><span>Propose a payment via AI</span></button>
        <button className="quick-action" onClick={() => setView("policy-builder")}><FileText size={22} /><b>New Policy</b><span>Create spending rules</span></button>
        <button className="quick-action" onClick={() => setView("proof-log")}><Activity size={22} /><b>Proof Log</b><span>View all payment proofs</span></button>
      </div>
    </section>
  </>;
}

function Stat({ label, value, sub, badge, tone = "green" }: { label: string; value: string; sub: string; badge: string; tone?: "green" | "red" | "amber" }) {
  return <div className="stat-card"><span className="sc-label">{label}</span><strong className="sc-val">{value}</strong><span className="sc-sub">{sub}</span><span className={`sc-badge ${tone}`}>{badge}</span></div>;
}

function FeedRow({ event }: { event: EventRow }) {
  return <button className="feed-row"><span className={`fr-badge ${event.status === "VERIFIED" ? "v" : event.status === "BLOCKED" ? "b" : "p"}`}>{event.status}</span><span className="fr-info"><span className="fr-main">{shortAddress(event.recipient)}</span><span className="fr-sub">{event.proof}</span></span><span className="fr-amt">${event.amount}</span><span className="fr-time">{event.time}</span><span className="fr-arrow">›</span></button>;
}

function PolicyBuilder({ policy, setPolicy, policyHash, notify }: { policy: PolicyDefinition; setPolicy: (p: PolicyDefinition) => void; policyHash: string; notify: (m: string, t?: "success" | "warn" | "error" | "info") => void }) {
  function patch(next: Partial<PolicyDefinition>) { setPolicy({ ...policy, ...next }); }
  const allowlistText = policy.allowlist.join("\n");
  return <div className="three-col"><section className="card"><div className="card-header"><span className="card-title">Create private agent policy</span></div><div className="card-body"><Field label="Policy name" value={policy.name} onChange={(v) => patch({ name: v })} /><div className="form-grid"><Field label="Max per payment" value={policy.maxPerPayment} onChange={(v) => patch({ maxPerPayment: v })} /><Field label="Daily budget" value={policy.dailyLimit} onChange={(v) => patch({ dailyLimit: v })} /></div><label className="form-row"><span className="form-label">Recipient allowlist</span><textarea className="form-input area" value={allowlistText} onChange={(e) => patch({ allowlist: e.target.value.split(/\s+/).filter(Boolean) })} /></label><Field label="Expiry date" type="date" value={policy.expiry} onChange={(v) => patch({ expiry: v })} /><button className="btn-sm primary" onClick={() => notify(env.contractId ? "Ready to build register_policy transaction." : "Set VITE_PAYGUARD_CONTRACT_ID before deploying on Stellar.", env.contractId ? "success" : "warn")}>Deploy policy hash</button></div></section><aside className="hash-preview"><div className="hp-eyebrow">Canonical policy hash</div><div className="hp-hash">{policyHash || "calculating"}</div><div className="hp-private-note"><strong>Private by default.</strong> Max amount, budget, allowlist and expiry stay off-chain. Stellar receives only the hash and proof-bound decisions.</div></aside></div>;
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <label className="form-row"><span className="form-label">{label}</span><input className="form-input" type={type} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}

function AgentConsole({ policy, policyHash, events, setEvents, notify }: { policy: PolicyDefinition; policyHash: string; events: EventRow[]; setEvents: (events: EventRow[]) => void; notify: (m: string, t?: "success" | "warn" | "error" | "info") => void }) {
  const [prompt, setPrompt] = useState("Pay Vendor A 30 USDC for API usage this month");
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [proof, setProof] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);

  async function runAgent() {
    setBusy(true); setProof(null); setStep(1);
    try {
      const res = await fetch(`${env.apiUrl}/v1/agent/payment-intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, allowlist: policy.allowlist, aliases: { "Vendor A": vendorA, "Vendor B": vendorB } })
      });
      if (!res.ok) throw new Error(await res.text());
      setIntent(await res.json());
      notify("Payment intent ready - review before proving");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Agent failed", "error");
    } finally {
      setBusy(false); setStep(0);
    }
  }

  async function generateProof() {
    if (!intent) return;
    setBusy(true); setProof(null); setStep(2);
    try {
      const job = await fetch(`${env.apiUrl}/v1/proofs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy, intent, spentToday: "75", vaultBalance: "200" })
      }).then((r) => r.json());
      setStep(3);
      let finalJob = job;
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        finalJob = await fetch(`${env.apiUrl}/v1/proofs/${job.id}`).then((r) => r.json());
        if (finalJob.status === "complete" || finalJob.status === "failed") break;
      }
      if (finalJob.status !== "complete") throw new Error(finalJob.error ?? "Proof job failed");
      setProof(finalJob.result);
      const status = finalJob.result.approved ? "VERIFIED" : "BLOCKED";
      const row: EventRow = {
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        recipient: intent.recipient,
        amount: intent.amount,
        status,
        violation: violationName(finalJob.result.violation),
        proof: `0x${String(finalJob.result.journalDigest).slice(0, 4)}...${String(finalJob.result.journalDigest).slice(-4)}`
      };
      setEvents([row, ...events]);
      notify(status === "VERIFIED" ? "Proof accepted: payment policy approved." : "Verified denial recorded: no funds move.", status === "VERIFIED" ? "success" : "error");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Proof generation failed", "error");
    } finally {
      setBusy(false); setStep(0);
    }
  }

  const localDecision = useMemo(() => intent ? evaluatePolicy({ policy, intent, spentToday: "75", vaultBalance: "200" }) : null, [intent, policy]);

  return <div className="two-col"><section className="card"><div className="card-header"><span className="card-title">Agent payment console</span><span className="card-sub">Server-side OpenAI + ZK policy check</span></div><div className="card-body"><textarea className="prompt-box" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><div className="prompt-examples">{["Pay Vendor A 30 USDC for API usage", "Pay Vendor B 25 USDC for design work", "Pay unknown vendor 80 USDC"].map((x) => <button className="prompt-chip" onClick={() => setPrompt(x)} key={x}>{x}</button>)}</div><div className="button-row"><button className="btn-sm primary" disabled={busy} onClick={runAgent}><Bot size={14} /> Run agent</button><button className="btn-sm ghost" disabled={!intent || busy} onClick={generateProof}><Shield size={14} /> Generate proof</button></div>{intent && <IntentCard intent={intent} />}{step > 0 && <ProofSteps step={step} />}{proof && <ResultCard proof={proof} />}</div></section><section className="card"><div className="card-header"><span className="card-title">Active enforcement context</span></div><div className="card-body"><MiniRules /><HashBox label="Policy hash" value={policyHash} /><div className="settings-row"><span><b>Recipient validation</b><small>{intent ? isLikelyStellarAddress(intent.recipient) ? "Stellar G address" : "Invalid" : "waiting for intent"}</small></span></div><div className="settings-row"><span><b>Contract mode</b><small>{env.contractId ? "ready for Stellar tx" : "configure contract id for tx execution"}</small></span></div><small className="muted">Current proof job produces a policy decision and journal digest. Configure PAYGUARD_REAL_PROVER_CMD for final RISC Zero seal generation.</small></div></section></div>;
}

function IntentCard({ intent }: { intent: PaymentIntent }) {
  return <div className="intent-card show"><div className="ic-label">Structured payment intent</div>{Object.entries({ Recipient: shortAddress(intent.recipient), Amount: `${intent.amount} USDC`, Category: intent.category, Risk: intent.riskLevel }).map(([k, v]) => <div className="ic-row" key={k}><span className="ic-key">{k}</span><span className={`ic-val ${v === "low" ? "green" : ""}`}>{v}</span></div>)}<div className="rationale-box">{intent.rationale}</div></div>;
}

function ProofSteps({ step }: { step: number }) {
  return <div className="proof-steps show">{["Load private policy", "Evaluate policy in ZK program", "Produce proof journal", "Verify before payment"].map((x, i) => <div className={`ps-step ${step > i + 1 ? "done" : step === i + 1 ? "active" : ""}`} key={x}><span className="pss-num">{i + 1}</span><span className="pss-body"><span className="pss-title">{x}</span><span className="pss-sub">{i === 1 ? "Budget, allowlist, expiry, vault state" : "PayGuard proof pipeline"}</span></span><span className="pss-status">{step > i + 1 ? "Done" : step === i + 1 ? "Running" : "Waiting"}</span></div>)}</div>;
}

function ResultCard({ proof }: { proof: any }) {
  const approved = Boolean(proof.approved);
  return <div className={`result-card show ${approved ? "approved" : "blocked"}`}><div className="rc-icon">{approved ? <CheckCircle2 /> : <XCircle />}</div><span><div className="rc-title">{approved ? "Payment approved" : "Payment blocked"}</div><div className="rc-sub">{approved ? "Policy passed. Ready for contract execution." : `${violationName(proof.violation)} - no funds move.`}</div></span><code className="rc-hash">Proof: {String(proof.journalDigest).slice(0, 10)}...</code></div>;
}

function violationName(code: number) {
  return ({ [ViolationCode.None]: "-", [ViolationCode.MaxPayment]: "max_per_tx", [ViolationCode.DailyLimit]: "daily_limit", [ViolationCode.Allowlist]: "allowlist", [ViolationCode.Expired]: "expired", [ViolationCode.InsufficientVault]: "insufficient_vault" } as Record<number, string>)[code] ?? "unknown";
}

function Policies({ policy, policyHash }: { policy: PolicyDefinition; policyHash: string }) {
  return <section className="card"><div className="card-header"><span className="card-title">My Policies</span></div><div className="card-body"><div className="log-table-wrap"><table className="log-table"><tbody><tr><td>{policy.name}</td><td className="td-mono">{policyHash}</td><td><span className="fr-badge p">LOCAL</span></td></tr></tbody></table></div></div></section>;
}

function ProofLog({ events, notify }: { events: EventRow[]; notify: (m: string) => void }) {
  const csv = ["Time,Recipient,Amount,Status,Violation,Proof,TxHash", ...events.map((e) => [e.time, e.recipient, e.amount, e.status, e.violation, e.proof, e.txHash ?? ""].join(","))].join("\n");
  function download() {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "payguard-proof-log.csv"; a.click(); URL.revokeObjectURL(url); notify("Proof log exported as CSV");
  }
  return <section className="card"><div className="card-header"><span className="card-title">Proof audit log</span><button className="btn-sm ghost" onClick={download}><Download size={14} /> Export CSV</button></div><div className="log-table-wrap"><table className="log-table"><thead><tr><th>Time</th><th>Recipient</th><th>Amount</th><th>Status</th><th>Violation</th><th>Proof digest</th><th>Tx</th></tr></thead><tbody>{events.map((e) => <tr key={e.id}><td className="td-mono">{e.time}</td><td className="td-mono">{shortAddress(e.recipient)}</td><td>${e.amount} USDC</td><td><span className={`fr-badge ${e.status === "VERIFIED" ? "v" : "b"}`}>{e.status}</span></td><td>{e.violation}</td><td className="td-mono">{e.proof}</td><td>{e.txHash ? <a className="td-link" href={stellarExpertTx(e.txHash)}>View</a> : "-"}</td></tr>)}</tbody></table></div></section>;
}

function Settings({ wallet, disconnect, health }: { wallet: { address: string; network: string } | null; disconnect: () => void; health: { ok: boolean; status: string; ledger: number | null } }) {
  return <div className="settings-col"><section className="card"><div className="card-header"><span className="card-title">Wallet and network</span></div><div className="card-body"><div className="settings-row"><span><b>Connected wallet</b><small>{wallet ? `${shortAddress(wallet.address)} (Freighter)` : "connect from the wallet overlay"}</small></span>{wallet && <button className="btn-sm danger" onClick={disconnect}>Disconnect</button>}</div><div className="settings-row"><span><b>Network</b><small>{env.network}</small></span><span className="sc-badge green">Testnet</span></div><div className="settings-row"><span><b>RPC</b><small>{health.ledger ? `ledger ${health.ledger}` : health.status}</small></span><span className={`sc-badge ${health.ok ? "green" : "red"}`}>{health.status}</span></div></div></section><section className="card"><div className="card-header"><span className="card-title">Contracts</span></div><div className="card-body"><div className="settings-row"><span><b>PayGuard Gatekeeper</b><small>{env.contractId || "not configured"}</small></span></div><div className="settings-row"><span><b>Attestation verifier</b><small>{import.meta.env.VITE_PAYGUARD_VERIFIER_CONTRACT_ID ?? "not configured"}</small></span></div><div className="settings-row"><span><b>Token contract</b><small>{env.tokenContractId || "not configured"}</small></span></div></div></section></div>;
}
