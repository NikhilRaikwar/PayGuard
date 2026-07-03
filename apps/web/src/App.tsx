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
  gatekeeperJournalDigest,
  hashPolicy,
  isLikelyStellarAddress,
  parseUsdc,
  shortAddress,
  type PaymentIntent,
  type PolicyDefinition,
  ViolationCode,
  sha256Hex,
  hexToBytes,
  bytesToHex
} from "@payguard/protocol";
import * as StellarSdk from "@stellar/stellar-sdk";
import {
  apiStatus,
  connectFreighter,
  env,
  restoreFreighter,
  rpcHealth,
  stellarExpertTx,
  buildContractCall,
  signAndSubmit,
  scBytes32,
  scAddress,
  scI128,
  getNetworkHash,
  executeDecision,
  getPolicyState,
  getPolicyStats
} from "./stellar";

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
type ApiStatus = Awaited<ReturnType<typeof apiStatus>>;

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

const seedEvents: EventRow[] = [];

async function computePolicyId(policyHash: string, salt: string): Promise<string> {
  const hashBytes = hexToBytes(policyHash);
  const saltHash = await sha256Hex(salt);
  const saltBytes = hexToBytes(saltHash);
  const preimage = new Uint8Array(64);
  preimage.set(hashBytes, 0);
  preimage.set(saltBytes, 32);
  return sha256Hex(preimage);
}

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
  const [api, setApi] = useState<ApiStatus>({ ok: false, openai: false, realProverConfigured: false, contractId: env.contractId, verifierContractId: env.verifierContractId, tokenContractId: env.tokenContractId });

  const [activePolicy, setActivePolicy] = useState<PolicyDefinition | null>(() => {
    const saved = localStorage.getItem("payguard.activePolicy");
    return saved ? JSON.parse(saved) : null;
  });
  const [activePolicyHash, setActivePolicyHash] = useState("");
  const [vaultBalance, setVaultBalance] = useState("0");
  const [spentToday, setSpentToday] = useState("0");
  const [initialVault, setInitialVault] = useState("1000");

  const [showFundModal, setShowFundModal] = useState(false);
  const [fundAmountInput, setFundAmountInput] = useState("10");
  const [showRevokeModal, setShowRevokeModal] = useState(false);

  async function refreshOnChainState() {
    if (!wallet || !env.contractId || !activePolicy) return;
    try {
      const activeHash = await hashPolicy(activePolicy);
      const policyId = await computePolicyId(activeHash, activePolicy.salt);
      const state = await getPolicyState(policyId);
      if (state) {
        setVaultBalance(formatUsdc(BigInt(state.vault_balance)));
        setSpentToday(formatUsdc(BigInt(state.spent)));
      }
    } catch (err) {
      console.warn("Failed to load on-chain policy state:", err);
    }
  }

  useEffect(() => {
    restoreFreighter().then(setWallet).catch(() => undefined);
    rpcHealth().then(setHealth);
    apiStatus().then(setApi);
  }, []);

  useEffect(() => {
    hashPolicy(policy).then(setPolicyHash).catch((error) => setPolicyHash(`invalid:${error.message}`));
  }, [policy]);

  useEffect(() => {
    if (activePolicy) {
      hashPolicy(activePolicy).then(setActivePolicyHash).catch(() => setActivePolicyHash(""));
    } else {
      setActivePolicyHash("");
      setVaultBalance("0");
      setSpentToday("0");
    }
  }, [activePolicy]);

  useEffect(() => {
    refreshOnChainState();
  }, [wallet, activePolicy]);

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
    setInApp(false);
    location.hash = "";
    notify("Wallet disconnected", "warn");
  }

  async function deployPolicy() {
    if (!wallet) {
      notify("Please connect your wallet first", "warn");
      return;
    }
    if (!env.contractId) {
      notify("VITE_PAYGUARD_CONTRACT_ID is not configured", "error");
      return;
    }

    notify("Registering policy on-chain...", "info");
    try {
      const pHash = await hashPolicy(policy);
      const pHashBytes = scBytes32(pHash);
      const saltHash = await sha256Hex(policy.salt);
      const saltBytes = scBytes32(saltHash);

      const ownerVal = scAddress(wallet.address);
      const executorVal = scAddress(wallet.address);

      const tokenAddress = env.tokenContractId || "CDLZFC3SYJYD5765ZP65CH3N4ZPP7QCQPVEAW57KYN22A2KU2C64VUT7";
      const tokenVal = scAddress(tokenAddress);

      const xdr = await buildContractCall({
        source: wallet.address,
        contractId: env.contractId,
        method: "register_policy",
        args: [ownerVal, executorVal, tokenVal, pHashBytes, saltBytes]
      });

      notify("Please sign the transaction in Freighter...", "info");
      await signAndSubmit(xdr);

      const policyId = await computePolicyId(pHash, policy.salt);
      notify(`Policy deployed! ID: ${shortAddress(policyId)}`, "success");

      localStorage.setItem("payguard.activePolicy", JSON.stringify(policy));
      setActivePolicy(policy);
      setVaultBalance(initialVault);
      setSpentToday("0");
      setView("dashboard");
      await refreshOnChainState();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Failed to deploy policy", "error");
    }
  }

  function revokePolicy() {
    if (!wallet) {
      notify("Please connect your wallet first", "warn");
      return;
    }
    setShowRevokeModal(true);
  }

  async function executeRevoke() {
    setShowRevokeModal(false);
    try {
      if (wallet && env.contractId && activePolicy) {
        notify("Revoking policy on-chain...", "info");
        const activeHash = await hashPolicy(activePolicy);
        const policyId = await computePolicyId(activeHash, activePolicy.salt);
        const policyIdBytes = scBytes32(policyId);

        const xdr = await buildContractCall({
          source: wallet.address,
          contractId: env.contractId,
          method: "set_policy_active",
          args: [policyIdBytes, StellarSdk.nativeToScVal(false)]
        });
        await signAndSubmit(xdr);
        notify("Policy successfully deactivated on Soroban", "success");
      } else {
        notify("Policy draft revoked locally", "warn");
      }
      localStorage.removeItem("payguard.activePolicy");
      setActivePolicy(null);
      setVaultBalance("0");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Revocation failed", "error");
    }
  }

  function fundPolicy() {
    if (!wallet) {
      notify("Please connect your wallet first", "warn");
      return;
    }
    setFundAmountInput("10");
    setShowFundModal(true);
  }

  async function executeFunding() {
    setShowFundModal(false);
    if (!fundAmountInput) return;
    try {
      const amountBig = parseUsdc(fundAmountInput);
      if (wallet && env.contractId && activePolicy && activePolicyHash) {
        notify("Funding policy on-chain...", "info");
        const policyId = await computePolicyId(activePolicyHash, activePolicy.salt);
        const policyIdBytes = scBytes32(policyId);
        const fromVal = scAddress(wallet.address);

        const xdr = await buildContractCall({
          source: wallet.address,
          contractId: env.contractId,
          method: "fund_policy",
          args: [policyIdBytes, fromVal, scI128(amountBig)]
        });
        await signAndSubmit(xdr);
        notify("Vault successfully funded on Soroban", "success");
        await refreshOnChainState();
      } else {
        setVaultBalance((prev) => String(Number(prev) + Number(fundAmountInput)));
        notify(`Vault funded locally with ${fundAmountInput} USDC`, "success");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "Funding failed", "error");
    }
  }

  function saveDraft() {
    localStorage.setItem("payguard.activePolicy", JSON.stringify(policy));
    setActivePolicy(policy);
    notify("Policy draft saved locally", "success");
  }

  if (!inApp) return <Landing connect={connect} connecting={connecting} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="sb-logo" onClick={() => setView("dashboard")}>
          <span className="sb-logo-icon"><ShieldCheck size={15} /></span>
          <span className="sb-logo-name">PayGuard<span> Agent</span></span>
        </button>
        <SideNav view={view} setView={setView} setPolicy={setPolicy} setInitialVault={setInitialVault} />
        <div className="sb-wallet">
          <div className="sb-wallet-card wallet-menu">
            <div className="swc-label">Connected wallet</div>
            {wallet ? (
              <>
                <div className="swc-addr">{shortAddress(wallet.address)}</div>
                <div className="swc-net"><span className="swc-net-dot" /> {wallet.network}</div>
                <button className="wallet-disconnect" onClick={disconnect}><LogOut size={13} /> Disconnect wallet</button>
              </>
            ) : (
              <>
                <div className="swc-addr" style={{ color: "var(--ink4)" }}>Disconnected</div>
                <button className="wallet-connect-btn" onClick={connect} disabled={connecting} style={{ marginTop: "10px", width: "100%", background: "var(--amber)", color: "var(--ink)", padding: "6px 8px", borderRadius: "6px", fontWeight: "600", fontSize: "12px", textAlign: "center", display: "block", border: "none", cursor: "pointer" }}>
                  {connecting ? "Connecting..." : "Connect wallet"}
                </button>
              </>
            )}
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-title">{pageTitle(view)}</div>
          <div className="topbar-right">
            <span className={`sc-badge ${health.ok ? "green" : "red"}`}>RPC {health.status}</span>
            <button className="btn-sm ghost" onClick={() => { rpcHealth().then(setHealth); apiStatus().then(setApi); }}><RefreshCcw size={14} /> Refresh</button>
            <button className="btn-sm primary" onClick={() => setView("agent")}><Bot size={14} /> Ask Agent</button>
          </div>
        </header>
        <section className="content">
          {view === "dashboard" && (
            <Dashboard
              policy={activePolicy}
              policyHash={activePolicyHash}
              events={events}
              health={health}
              api={api}
              setView={setView}
              vaultBalance={vaultBalance}
              spentToday={spentToday}
              revokePolicy={revokePolicy}
              fundPolicy={fundPolicy}
              setPolicy={setPolicy}
              setInitialVault={setInitialVault}
            />
          )}
          {view === "agent" && (
            <AgentConsole
              policy={activePolicy}
              policyHash={activePolicyHash}
              events={events}
              setEvents={setEvents}
              notify={notify}
              api={api}
              spentToday={spentToday}
              vaultBalance={vaultBalance}
              setSpentToday={setSpentToday}
              setVaultBalance={setVaultBalance}
              wallet={wallet}
            />
          )}
          {view === "policy-builder" && (
            <PolicyBuilder
              policy={policy}
              setPolicy={setPolicy}
              policyHash={policyHash}
              notify={notify}
              deployPolicy={deployPolicy}
              saveDraft={saveDraft}
              initialVault={initialVault}
              setInitialVault={setInitialVault}
            />
          )}
          {view === "policies" && (
            <Policies
              policy={activePolicy}
              policyHash={activePolicyHash}
              setView={setView}
              setPolicy={setPolicy}
              setInitialVault={setInitialVault}
              revokePolicy={revokePolicy}
              vaultBalance={vaultBalance}
            />
          )}
          {view === "proof-log" && <ProofLog events={events} notify={notify} />}
          {view === "settings" && <Settings wallet={wallet} disconnect={disconnect} health={health} api={api} />}
        </section>
      </main>
      {toast && <div id="toast" className="show"><span className={`t-icon ${toast.tone}`} /> <span>{toast.message}</span></div>}

      {/* Custom Fund Modal */}
      {showFundModal && (
        <div className="modal-overlay">
          <div className="modal-card">
            <div className="modal-card-header">
              <h3>Fund Policy Vault</h3>
              <button className="modal-close-btn" onClick={() => setShowFundModal(false)}>&times;</button>
            </div>
            <div className="modal-card-body">
              <p>Enter the amount of USDC to deposit from your wallet into the secure contract vault.</p>
              <div className="modal-input-wrap">
                <input
                  type="number"
                  className="modal-input"
                  placeholder="10"
                  value={fundAmountInput}
                  onChange={(e) => setFundAmountInput(e.target.value)}
                  autoFocus
                />
                <span className="modal-suffix">USDC</span>
              </div>
            </div>
            <div className="modal-card-footer">
              <button className="btn-cancel" onClick={() => setShowFundModal(false)}>Cancel</button>
              <button className="btn-confirm" onClick={executeFunding}>Confirm Fund</button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Revoke Modal */}
      {showRevokeModal && (
        <div className="modal-overlay">
          <div className="modal-card">
            <div className="modal-card-header">
              <h3>Revoke Policy</h3>
              <button className="modal-close-btn" onClick={() => setShowRevokeModal(false)}>&times;</button>
            </div>
            <div className="modal-card-body">
              <p>Are you sure you want to deactivate and revoke this policy? Soroban will immediately reject all future payments and return all remaining vault funds back to your wallet.</p>
            </div>
            <div className="modal-card-footer">
              <button className="btn-cancel" onClick={() => setShowRevokeModal(false)}>Cancel</button>
              <button className="btn-danger" onClick={executeRevoke}>Confirm Revoke</button>
            </div>
          </div>
        </div>
      )}
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
          <h1>AI agents can propose payments.<br /><em>Only math can approve them.</em></h1>
          <p className="hero-sub">PayGuard Agent enforces your spending rules with zero-knowledge proofs on Stellar — before any token moves.<br />Private limits, allowlists & budgets required. Proof passed, or payment blocked.</p>
          <div className="hero-actions" style={{ display: "flex", gap: "12px", flexWrap: "nowrap", alignItems: "center", marginBottom: "48px" }}>
            <button className="btn-hero-primary" onClick={connect} disabled={connecting} style={{ whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "8px" }}>
              <Wallet size={15} /> Connect wallet & start
            </button>
            <a className="btn-hero-secondary" href="#how" style={{ whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "6px" }}>
              See the full proof flow &rarr;
            </a>
          </div>
          <div className="hero-trust" style={{ display: "flex", gap: "16px", flexWrap: "nowrap", whiteSpace: "nowrap" }}>
            <Trust text="RISC Zero zkVM" />
            <Trust text="RISC Zero Groth16 (BN254)" />
            <Trust text="Soroban Gatekeeper" />
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
          <p className="s-sub">Your rules never touch the blockchain. Only a cryptographic fingerprint is stored on Stellar.</p>
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
          <p>Connect a Stellar wallet to deploy your first payment policy. No account, no email — just your wallet and your rules.</p>
          <button className="btn-cta-big" onClick={connect} disabled={connecting}><Lock size={16} /> {connecting ? "Connecting wallet" : "Connect wallet and start"}</button>
          <p className="cta-note">Non-custodial - Stellar testnet - Open source - MIT license</p>
        </div>
      </section>
      <footer>
        <div className="footer-w">
          <span className="fl-name">PayGuard<span> Agent</span></span>
          <span style={{ fontSize: "12px", color: "rgba(255, 255, 255, 0.4)", fontFamily: "var(--sans)" }}>
            Private rules. Public verification. Real-World ZK on Stellar.
          </span>
          <span className="footer-note">Submitted for Stellar Hacks: Real-World ZK 2026</span>
        </div>
      </footer>
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

function MiniRules({ policy, policyHash = "0x7f2a9c3e4b1d8f0a2e6b9c4f7a3d1e8b" }: { policy?: PolicyDefinition | null; policyHash?: string }) {
  const activePolicy = policy === undefined ? defaultPolicy : policy;
  if (!activePolicy) {
    return (
      <>
        <div className="mini-label">Your private rules (local only)</div>
        <div style={{ padding: "10px 0", color: "var(--ink4)", fontSize: "13px" }}>No active policy configured.</div>
      </>
    );
  }
  return (
    <>
      <div className="mini-label">Your private rules (local only)</div>
      <div className="dark-row">
        <span className="dr-name">Max per payment</span>
        <span className="dr-val">&le; ${activePolicy.maxPerPayment || "0"} USDC</span>
      </div>
      <div className="dark-row">
        <span className="dr-name">Daily budget</span>
        <span className="dr-val">&le; ${activePolicy.dailyLimit || "0"} USDC</span>
      </div>
      <div className="dark-row">
        <span className="dr-name">Allowed vendors</span>
        <span className="dr-val">{activePolicy.allowlist.length} {activePolicy.allowlist.length === 1 ? "address" : "addresses"}</span>
      </div>
      <HashBox label="POLICY FINGERPRINT - on Stellar only" value={policyHash || "calculating"} />
    </>
  );
}

function HashBox({ label, value }: { label: string; value: string }) {
  return <div className="hash-box"><div className="hb-label">{label}</div><div className="hb-val">{value}</div></div>;
}

function FeatureSections() {
  const features = [
    ["Visual rule builder", "Set spending limits, approved vendors and expiry dates. Your rules stay on your device.", "No smart contract coding required"],
    ["Cryptographic enforcement", "Every payment decision is represented as a proof-bound public journal for Stellar verification.", "RISC Zero - Groth16"],
    ["AI agent payments", "Paste a task or invoice. The agent proposes a structured payment that policy checks can enforce.", "OpenAI - structured intent"],
    ["Proof audit log", "Approved and blocked payments are recorded with proof digests and exportable CSV evidence.", "Tamper-proof"],
    ["Instant kill switch", "Disable an agent policy and block all future payment execution.", "Revoke instantly"],
    ["Stellar-native", "Designed around Stellar testnet, SAC token transfers and protocol ZK primitives.", "Protocol 25 - 26"]
  ];
  const steps = [
    ["Agent Proposes", "Agent proposes a structured payment intent"],
    ["Rules Evaluate", "Private rules evaluated in ZK"],
    ["Proof Generated", "Zero-knowledge proof generated"],
    ["Stellar Verifies", "Soroban smart contract verifies proof"],
    ["Approved or Blocked", "Payment approved or blocked on Stellar"]
  ];
  return (
    <>
      <section className="section feat-section" id="features">
        <div className="section-w">
          <div className="s-eyebrow">Everything included</div>
          <h2 className="s-title">Built for teams that delegate<br />payments to AI</h2>
          <p className="s-sub">Every part of PayGuard Agent is designed around one principle: your rules are enforced by math, not trust.</p>
          <div className="feat-grid">
            {features.map((f, i) => (
              <article className="feat-card" key={f[0]}>
                <div className="fc-icon">{[<FileText />, <Shield />, <Bot />, <Activity />, <PauseCircle />, <Zap />][i]}</div>
                <div className="fc-t">{f[0]}</div>
                <p className="fc-d">{f[1]}</p>
                <span className="fc-tag">{f[2]}</span>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section className="section flow-section">
        <div className="section-w">
          <div className="s-eyebrow">Under the hood</div>
          <h2 className="s-title">Every payment,<br />every proof, every time</h2>
          <p className="s-sub">From agent proposal to on-chain settlement - five steps, no shortcuts.</p>
          <div className="flow-grid">
            {steps.map((step, i) => (
              <div className="flow-step" key={step[0]}>
                <div className="fs-num">{i + 1}</div>
                <div className="fs-t">{step[0]}</div>
                <p className="fs-d">{step[1]}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function SideNav({
  view,
  setView,
  setPolicy,
  setInitialVault
}: {
  view: View;
  setView: (view: View) => void;
  setPolicy?: (p: PolicyDefinition) => void;
  setInitialVault?: (v: string) => void;
}) {
  return <>
    <div className="sb-section">
      <div className="sb-section-label">Overview</div>
      <button className={`sb-item ${view === "dashboard" ? "active" : ""}`} onClick={() => setView("dashboard")}><LayoutDashboard className="sb-icon" />Dashboard<span className="sb-badge green">Live</span></button>
      <button className={`sb-item ${view === "agent" ? "active" : ""}`} onClick={() => setView("agent")}><Bot className="sb-icon" />Ask Agent<span className="sb-badge amber">AI</span></button>
    </div>
    <div className="sb-section">
      <div className="sb-section-label">Policies</div>
      <button
        className={`sb-item ${view === "policy-builder" ? "active" : ""}`}
        onClick={() => {
          if (setPolicy) {
            setPolicy({
              name: "",
              maxPerPayment: "",
              dailyLimit: "",
              allowlist: [],
              expiry: "",
              salt: `salt-${Math.random().toString(36).substring(2, 10)}`
            });
          }
          if (setInitialVault) {
            setInitialVault("");
          }
          setView("policy-builder");
        }}
      >
        <Plus className="sb-icon" />New Policy
      </button>
      <button className={`sb-item ${view === "policies" ? "active" : ""}`} onClick={() => setView("policies")}><KeyRound className="sb-icon" />My Policies</button>
    </div>
    <div className="sb-section">
      <div className="sb-section-label">Activity</div>
      <button className={`sb-item ${view === "proof-log" ? "active" : ""}`} onClick={() => setView("proof-log")}><Activity className="sb-icon" />Proof Log</button>
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

function Dashboard({
  policy,
  policyHash,
  events,
  health,
  api,
  setView,
  vaultBalance,
  spentToday,
  revokePolicy,
  fundPolicy,
  setPolicy,
  setInitialVault
}: {
  policy: PolicyDefinition | null;
  policyHash: string;
  events: EventRow[];
  health: { ok: boolean; status: string; ledger: number | null };
  api: ApiStatus;
  setView: (view: View) => void;
  vaultBalance: string;
  spentToday: string;
  revokePolicy: () => void;
  fundPolicy: () => void;
  setPolicy: (p: PolicyDefinition) => void;
  setInitialVault: (v: string) => void;
}) {
  const verified = events.filter((e) => e.status === "VERIFIED").length;
  const blocked = events.filter((e) => e.status === "BLOCKED").length;
  return <>
    <div className="stat-grid">
      <div className="stat-card">
        <span className="sc-label">Vault balance</span>
        <strong className="sc-val">{vaultBalance}</strong>
        <span className="sc-sub" style={{ fontFamily: "var(--mono)", color: "var(--ink3)" }}>USDC · testnet</span>
        <span className="sc-badge green" style={{ marginTop: "8px" }}>● {Number(vaultBalance) > 0 ? "Funded" : "Empty"}</span>
      </div>
      <div className="stat-card">
        <span className="sc-label">Today's spend</span>
        <strong className="sc-val">{spentToday}</strong>
        <span className="sc-sub" style={{ fontFamily: "var(--mono)", color: "var(--ink3)" }}>USDC of {policy?.dailyLimit || "0"} limit</span>
        <div style={{ marginTop: "8px", height: "4px", background: "var(--c3)", borderRadius: "2px", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.min(100, (Number(spentToday) / (Number(policy?.dailyLimit) || 1)) * 100)}%`, background: "var(--amber)", borderRadius: "2px" }} />
        </div>
      </div>
      <div className="stat-card">
        <span className="sc-label">Payments approved</span>
        <strong className="sc-val">{verified}</strong>
        <span className="sc-sub">since policy deployed</span>
        <span className="sc-badge green" style={{ marginTop: "8px" }}>● All proven</span>
      </div>
      <div className="stat-card">
        <span className="sc-label">Payments blocked</span>
        <strong className="sc-val">{blocked}</strong>
        <span className="sc-sub">violations caught</span>
        <span className="sc-badge red" style={{ marginTop: "8px" }}>● Recorded on-chain</span>
      </div>
    </div>
    <div className="two-col">
      <section className="card">
        <div className="card-header">
          <span className="card-title">Recent payments</span>
          <button className="btn-sm ghost" onClick={() => setView("proof-log")}>{"View all ->"}</button>
        </div>
        <div>
          {events.length === 0 ? (
            <div className="empty-state">
              <span className="es-icon">📊</span>
              <div className="es-title">No payments yet</div>
              <div className="es-desc">Run the AI agent console or check policy rules to verify and execute agent payments.</div>
            </div>
          ) : (
            events.slice(0, 5).map((event) => <FeedRow event={event} key={event.id} />)
          )}
        </div>
      </section>
      <section className="card">
        <div className="card-header">
          <span className="card-title">Active policy</span>
          <span className={`sc-badge ${policy ? "green" : "red"}`}>{policy ? "Active" : "Inactive"}</span>
        </div>
        <div className="card-body">
          {policy ? (
            <>
              <div style={{ marginBottom: "14px" }}>
                <div style={{ fontSize: "14px", fontWeight: "700", marginBottom: "2px" }}>{policy.name}</div>
                <div style={{ fontSize: "12px", color: "var(--ink4)", fontFamily: "var(--mono)", marginBottom: "14px" }}>Deployed Jun 27 · Expires {policy.expiry}</div>
              </div>
              <div className="rule-row">
                <span className="rr-dot amber-dot" />
                <span className="rr-name">Max per payment</span>
                <span className="rr-val">≤ ${policy.maxPerPayment} USDC</span>
              </div>
              <div className="rule-row">
                <span className="rr-dot green-dot" />
                <span className="rr-name">Daily budget</span>
                <span className="rr-val">≤ ${policy.dailyLimit} USDC</span>
              </div>
              <div className="rule-row">
                <span className="rr-dot purple-dot" />
                <span className="rr-name">Allowed vendors</span>
                <span className="rr-val">{policy.allowlist.length} addresses</span>
              </div>
              <div className="rule-row">
                <span className="rr-dot red-dot" />
                <span className="rr-name">Expires</span>
                <span className="rr-val">{policy.expiry}</span>
              </div>
              <HashBox label="ON-CHAIN HASH" value={policyHash || "calculating"} />
              <div className="button-row" style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                <button className="btn-sm ghost fill" onClick={() => {
                  setPolicy(policy);
                  setInitialVault(vaultBalance);
                  setView("policy-builder");
                }}>Edit</button>
                <button className="btn-sm primary fill" onClick={fundPolicy}>Fund</button>
                <button className="btn-sm danger fill" onClick={revokePolicy}>Revoke</button>
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ padding: "30px 14px" }}>
              <span className="es-icon" style={{ fontSize: "24px" }}>🔒</span>
              <div className="es-title" style={{ fontSize: "14px" }}>No active policy</div>
              <div className="es-desc" style={{ fontSize: "12px" }}>Deploy a spending policy to get started.</div>
              <button className="btn-sm primary" onClick={() => setView("policy-builder")} style={{ marginTop: "8px" }}>Create policy</button>
            </div>
          )}
        </div>
      </section>
    </div>
    <section className="card">
      <div className="card-header">
        <span className="card-title">Quick actions</span>
        <span className={`sc-badge ${api.realProverConfigured ? "green" : "amber"}`}>
          {api.realProverConfigured ? "RISC Zero Groth16 live" : "Dev evaluator"}
        </span>
      </div>
      <div className="quick-grid">
        <button className="quick-action" onClick={() => setView("agent")}>
          <Bot size={22} />
          <b>Ask Agent</b>
          <span>Propose a payment via AI</span>
        </button>
        <button className="quick-action" onClick={() => {
          setPolicy({
            name: "",
            maxPerPayment: "",
            dailyLimit: "",
            allowlist: [],
            expiry: "",
            salt: `salt-${Math.random().toString(36).substring(2, 10)}`
          });
          setInitialVault("");
          setView("policy-builder");
        }}>
          <FileText size={22} />
          <b>New Policy</b>
          <span>Create spending rules</span>
        </button>
        <button className="quick-action" onClick={() => setView("proof-log")}>
          <Activity size={22} />
          <b>Proof Log</b>
          <span>View all payment proofs</span>
        </button>
      </div>
    </section>
  </>;
}

function IntegrationRow({ label, value, tone, href }: { label: string; value: string; tone: "green" | "amber" | "red"; href?: string }) {
  return <div className="integration-row"><span><b>{label}</b><small>{href ? <a href={href} target="_blank" rel="noreferrer">{value}</a> : value}</small></span><span className={`sc-badge ${tone}`}>{tone === "green" ? "Live" : tone === "amber" ? "Ready" : "Missing"}</span></div>;
}

function contractLink(id: string) {
  return id ? `https://stellar.expert/explorer/testnet/contract/${id}` : "";
}

function Stat({ label, value, sub, badge, tone = "green" }: { label: string; value: string; sub: string; badge: string; tone?: "green" | "red" | "amber" }) {
  return <div className="stat-card"><span className="sc-label">{label}</span><strong className="sc-val">{value}</strong><span className="sc-sub">{sub}</span><span className={`sc-badge ${tone}`}>{badge}</span></div>;
}

function FeedRow({ event }: { event: EventRow }) {
  return <button className="feed-row"><span className={`fr-badge ${event.status === "VERIFIED" ? "v" : event.status === "BLOCKED" ? "b" : "p"}`}>{event.status}</span><span className="fr-info"><span className="fr-main">{shortAddress(event.recipient)}</span><span className="fr-sub">{event.proof}</span></span><span className="fr-amt">${event.amount}</span><span className="fr-time">{event.time}</span><span className="fr-arrow">›</span></button>;
}

function PolicyBuilder({
  policy,
  setPolicy,
  policyHash,
  notify,
  deployPolicy,
  saveDraft,
  initialVault,
  setInitialVault
}: {
  policy: PolicyDefinition;
  setPolicy: (p: PolicyDefinition) => void;
  policyHash: string;
  notify: (m: string, t?: "success" | "warn" | "error" | "info") => void;
  deployPolicy: () => void;
  saveDraft: () => void;
  initialVault: string;
  setInitialVault: (v: string) => void;
}) {
  const [recipientInput, setRecipientInput] = useState("");

  function patch(next: Partial<PolicyDefinition>) { setPolicy({ ...policy, ...next }); }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = recipientInput.trim();
      if (!val) return;
      if (!policy.allowlist.includes(val)) {
        patch({ allowlist: [...policy.allowlist, val] });
      }
      setRecipientInput("");
    }
  };

  const removeRecipient = (index: number) => {
    const next = [...policy.allowlist];
    next.splice(index, 1);
    patch({ allowlist: next });
  };

  const hasSummary = policy.name || policy.maxPerPayment || policy.dailyLimit || policy.expiry || initialVault;

  return (
    <div className="three-col">
      <section className="card">
        <div className="card-header"><span className="card-title">Create a policy</span></div>
        <div className="card-body">
          <div className="form-row">
            <span className="form-label">Policy name</span>
            <input
              className="form-input"
              type="text"
              placeholder="e.g. DAO Treasury Agent"
              value={policy.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>

          <div className="form-row">
            <span className="form-label">Max payment amount (USDC)</span>
            <input
              className="form-input"
              type="number"
              placeholder="50"
              value={policy.maxPerPayment}
              onChange={(e) => patch({ maxPerPayment: e.target.value })}
            />
            <div className="form-hint" style={{ fontSize: "11px", color: "var(--ink4)", marginTop: "4px" }}>
              Agent cannot make a single payment above this amount
            </div>
          </div>

          <div className="form-row">
            <span className="form-label">Daily spending budget (USDC)</span>
            <input
              className="form-input"
              type="number"
              placeholder="200"
              value={policy.dailyLimit}
              onChange={(e) => patch({ dailyLimit: e.target.value })}
            />
            <div className="form-hint" style={{ fontSize: "11px", color: "var(--ink4)", marginTop: "4px" }}>
              Total spending resets every 24 hours
            </div>
          </div>

          <div className="form-row">
            <span className="form-label">Allowed recipients</span>
            <div className="tag-input-wrap" onClick={() => document.getElementById("tag-in")?.focus()}>
              {policy.allowlist.map((addr, i) => (
                <span className="tag-chip" key={addr}>
                  {shortAddress(addr)}
                  <button onClick={() => removeRecipient(i)}>×</button>
                </span>
              ))}
              <input
                className="tag-in"
                id="tag-in"
                placeholder="Add Stellar address…"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
            <div className="form-hint" style={{ fontSize: "11px", color: "var(--ink4)", marginTop: "4px" }}>
              Press Enter to add. Only these addresses can receive funds.
            </div>
          </div>

          <div className="form-row">
            <span className="form-label">Policy expiry</span>
            <input
              className="form-input"
              type="date"
              value={policy.expiry}
              onChange={(e) => patch({ expiry: e.target.value })}
            />
          </div>

          <div className="form-row">
            <span className="form-label">Initial vault amount (USDC)</span>
            <input
              className="form-input"
              type="number"
              placeholder="1000"
              value={initialVault}
              onChange={(e) => setInitialVault(e.target.value)}
            />
          </div>

          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            <button className="btn-sm ghost" onClick={saveDraft}>Save draft</button>
            <button className="btn-sm primary" onClick={deployPolicy}>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" style={{ marginRight: "4px" }}>
                <path d="M7 1L12 4V10L7 13L2 10V4L7 1Z" />
              </svg>
              Deploy to Stellar
            </button>
          </div>
        </div>
      </section>

      <aside className="hash-preview">
        <div className="hp-eyebrow">Policy fingerprint</div>
        <div className="hp-hash" style={{ color: "var(--amber)" }}>{policyHash || "calculating"}<br /><span style={{ opacity: 0.4 }}>(changes as you edit)</span></div>
        <div className="hp-private-note">
          <strong>Your rules stay private.</strong><br /><br />
          Only this 32-byte fingerprint is registered on Stellar. Nobody can reverse it to read your actual rule values.
        </div>
        <div style={{ marginTop: "14px", padding: "10px 12px", background: "rgba(255, 255, 255, 0.04)", borderRadius: "8px", border: "1px solid rgba(255, 255, 255, 0.08)" }}>
          <div style={{ fontSize: "10px", color: "rgba(255, 255, 255, 0.3)", fontFamily: "var(--mono)", marginBottom: "6px" }}>RULES SUMMARY</div>
          <div style={{ fontSize: "11px", color: "rgba(255, 255, 255, 0.5)", lineHeight: "1.8" }}>
            {hasSummary ? (
              <div>
                {policy.name && <>Name: {policy.name}<br /></>}
                {policy.maxPerPayment && <>Max per tx: ${policy.maxPerPayment} USDC<br /></>}
                {policy.dailyLimit && <>Daily limit: ${policy.dailyLimit} USDC<br /></>}
                {policy.expiry && <>Expires: {policy.expiry}<br /></>}
                {initialVault && <>Initial vault: ${initialVault} USDC</>}
              </div>
            ) : (
              "Fill in the form to see your policy summary"
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <label className="form-row"><span className="form-label">{label}</span><input className="form-input" type={type} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}

function AgentConsole({
  policy,
  policyHash,
  events,
  setEvents,
  notify,
  api,
  spentToday,
  vaultBalance,
  setSpentToday,
  setVaultBalance,
  wallet
}: {
  policy: PolicyDefinition | null;
  policyHash: string;
  events: EventRow[];
  setEvents: (events: EventRow[]) => void;
  notify: (m: string, t?: "success" | "warn" | "error" | "info") => void;
  api: ApiStatus;
  spentToday: string;
  vaultBalance: string;
  setSpentToday: React.Dispatch<React.SetStateAction<string>>;
  setVaultBalance: React.Dispatch<React.SetStateAction<string>>;
  wallet: { address: string; network: string } | null;
}) {
  const [prompt, setPrompt] = useState("Pay Vendor A 30 USDC for API usage this month");
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [proof, setProof] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);

  async function runAgent() {
    if (!policy) {
      notify("Please deploy an active policy first in the Policies page", "warn");
      return;
    }
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
    if (!intent || !policy) return;
    setBusy(true); setProof(null); setStep(2);
    try {
      let pendingExecution: {
        policyId: string;
        journal: Parameters<typeof executeDecision>[0]["journal"];
        executionContext: {
          networkHash: string;
          policyId: string;
          policyHash: string;
          amount: string;
          dayIndex: string;
          spentBefore: string;
          spentAfter: string;
          vaultBefore: string;
          vaultAfter: string;
          nonce: string;
          proofTimestamp: string;
          approved: boolean;
          violation: number;
          intentDigest: string;
        };
      } | null = null;

      const decision = await evaluatePolicy({ policy, intent, spentToday, vaultBalance });
      if (wallet && env.contractId) {
        const policyId = await computePolicyId(policyHash, policy.salt);
        const network_hash = await getNetworkHash();
        const tokenAddress = env.tokenContractId || "CDLZFC3SYJYD5765ZP65CH3N4ZPP7QCQPVEAW57KYN22A2KU2C64VUT7";

        let nonce = 0n;
        try {
          const contractPolicy = await getPolicyState(policyId);
          nonce = BigInt(contractPolicy.nonce);
        } catch {
          // Local preview can still generate a proof, but live execution needs contract state.
        }

        const amountBig = parseUsdc(intent.amount);
        const spentBeforeBig = parseUsdc(spentToday);
        const vaultBeforeBig = parseUsdc(vaultBalance);
        const approved = decision.approved;
        const violation = decision.violation;
        const spentAfterBig = approved ? spentBeforeBig + amountBig : spentBeforeBig;
        const vaultAfterBig = approved ? vaultBeforeBig - amountBig : vaultBeforeBig;
        const dayIndex = BigInt(Math.floor(Date.now() / 1000 / 86400));
        const proofTimestamp = BigInt(Math.floor(Date.now() / 1000));

        pendingExecution = {
          policyId,
          journal: {
            network_hash,
            gatekeeper: env.contractId,
            policy_id: policyId,
            policy_hash: policyHash,
            token: tokenAddress,
            executor: wallet.address,
            recipient: intent.recipient,
            amount: amountBig,
            day_index: dayIndex,
            spent_before: spentBeforeBig,
            spent_after: spentAfterBig,
            vault_before: vaultBeforeBig,
            vault_after: vaultAfterBig,
            nonce,
            proof_timestamp: proofTimestamp,
            approved,
            violation,
            intent_digest: decision.intentDigest
          },
          executionContext: {
            networkHash: network_hash,
            policyId,
            policyHash,
            amount: amountBig.toString(),
            dayIndex: dayIndex.toString(),
            spentBefore: spentBeforeBig.toString(),
            spentAfter: spentAfterBig.toString(),
            vaultBefore: vaultBeforeBig.toString(),
            vaultAfter: vaultAfterBig.toString(),
            nonce: nonce.toString(),
            proofTimestamp: proofTimestamp.toString(),
            approved,
            violation,
            intentDigest: decision.intentDigest
          }
        };

        await gatekeeperJournalDigest(pendingExecution.executionContext);
      }

      const job = await fetch(`${env.apiUrl}/v1/proofs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy, intent, spentToday, vaultBalance, executionContext: pendingExecution?.executionContext })
      }).then((r) => r.json());
      setStep(3);
      let finalJob = job;
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        finalJob = await fetch(`${env.apiUrl}/v1/proofs/${job.id}`).then((r) => r.json());
        if (finalJob.status === "complete" || finalJob.status === "failed") break;
      }
      if (finalJob.status !== "complete") throw new Error(finalJob.error ?? "Proof job failed");

      const result = finalJob.result;
      setProof(result);
      const status = result.approved ? "VERIFIED" : "BLOCKED";

      let txHash = "";
      if (wallet && env.contractId && pendingExecution) {
        notify("Submitting decision proof to Soroban contract...", "info");
        try {
          const txRes = await executeDecision({
            source: wallet.address,
            contractId: env.contractId,
            policyId: pendingExecution.policyId,
            sealHex: result.sealHex,
            journal: pendingExecution.journal
          });
          txHash = txRes.hash;
          notify(pendingExecution.journal.approved ? "Payment executed on Stellar testnet!" : "Verified denial recorded on Stellar testnet!", "success");

          // Reload from contract
          const updatedState = await getPolicyState(pendingExecution.policyId);
          if (updatedState) {
            setVaultBalance(formatUsdc(BigInt(updatedState.vault_balance)));
            setSpentToday(formatUsdc(BigInt(updatedState.spent)));
          }
        } catch (error) {
          console.error(error);
          notify("Failed to execute on Stellar: " + (error instanceof Error ? error.message : String(error)), "error");
        }
      } else {
        if (status === "VERIFIED") {
          setVaultBalance((prev) => {
            const next = Number(prev) - Number(intent.amount);
            return next >= 0 ? String(next) : "0";
          });
          setSpentToday((prev) => String(Number(prev) + Number(intent.amount)));
        }
      }

      const row: EventRow = {
        id: crypto.randomUUID(),
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        recipient: intent.recipient,
        amount: intent.amount,
        status,
        violation: violationName(result.violation),
        proof: `0x${String(result.journalDigest).slice(0, 4)}...${String(result.journalDigest).slice(-4)}`,
        txHash: txHash || undefined
      };
      setEvents([row, ...events]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Proof generation failed", "error");
    } finally {
      setBusy(false); setStep(0);
    }
  }

  const localDecision = useMemo(() => intent && policy ? evaluatePolicy({ policy, intent, spentToday, vaultBalance }) : null, [intent, policy, spentToday, vaultBalance]);

  return <div className="two-col"><section className="card"><div className="card-header"><span className="card-title">Agent payment console</span><span className="card-sub">{api.openai ? "OpenAI + RISC Zero policy check" : "Fallback intent + policy check"}</span></div><div className="card-body"><textarea className="prompt-box" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><div className="prompt-examples">{["Pay Vendor A 30 USDC for API usage", "Pay Vendor B 25 USDC for design work", "Pay unknown vendor 80 USDC"].map((x) => <button className="prompt-chip" onClick={() => setPrompt(x)} key={x}>{x}</button>)}</div><div className="button-row"><button className="btn-sm primary" disabled={busy || !policy} onClick={runAgent}><Bot size={14} /> Run agent</button><button className="btn-sm ghost" disabled={!intent || busy || !policy} onClick={generateProof}><Shield size={14} /> Generate proof</button></div>{!policy && <div style={{ background: "var(--amber-bg)", color: "var(--amber)", padding: "10px 12px", borderRadius: "8px", border: "1px solid rgba(245, 158, 11, 0.15)", fontSize: "12px", display: "flex", gap: "6px", alignItems: "center", marginTop: "12px" }}><Shield size={14} /> Please deploy an active policy first to enable agent payments.</div>}{intent && <IntentCard intent={intent} />}{step > 0 && <ProofSteps step={step} />}{proof && <ResultCard proof={proof} />}</div></section><section className="card"><div className="card-header"><span className="card-title">Active enforcement context</span><span className={`sc-badge ${api.realProverConfigured ? "green" : "amber"}`}>{api.realProverConfigured ? "RISC Zero" : "Dev"}</span></div><div className="card-body"><MiniRules policy={policy} policyHash={policyHash} /><HashBox label="Policy hash" value={policyHash || "no active policy"} /><HashBox label="RISC ZERO IMAGE ID" value={env.risc0ImageId || "waiting for env"} /><div className="settings-row"><span><b>Recipient validation</b><small>{intent ? isLikelyStellarAddress(intent.recipient) ? "Stellar G address" : "Invalid" : "waiting for intent"}</small></span></div><div className="settings-row"><span><b>Contract mode</b><small>{api.contractId ? "testnet gatekeeper configured" : "configure contract id"}</small></span></div><div className="settings-row"><span><b>Verifier mode</b><small>{api.verifierContractId ? shortAddress(api.verifierContractId) : "not configured"}</small></span></div><small className="muted">With PAYGUARD_REAL_PROVER_CMD set, proof jobs call the local RISC Zero host, verify the receipt, then return the journal digest and seal for the Stellar verifier boundary.</small></div></section></div>;
}

function IntentCard({ intent }: { intent: PaymentIntent }) {
  return <div className="intent-card show"><div className="ic-label">Structured payment intent</div>{Object.entries({ Recipient: shortAddress(intent.recipient), Amount: `${intent.amount} USDC`, Category: intent.category, Risk: intent.riskLevel }).map(([k, v]) => <div className="ic-row" key={k}><span className="ic-key">{k}</span><span className={`ic-val ${v === "low" ? "green" : ""}`}>{v}</span></div>)}<div className="rationale-box">{intent.rationale}</div></div>;
}

function ProofSteps({ step }: { step: number }) {
  return <div className="proof-steps show">{["Load private policy", "Evaluate policy in ZK program", "Produce proof journal", "Verify before payment"].map((x, i) => <div className={`ps-step ${step > i + 1 ? "done" : step === i + 1 ? "active" : ""}`} key={x}><span className="pss-num">{i + 1}</span><span className="pss-body"><span className="pss-title">{x}</span><span className="pss-sub">{i === 1 ? "Budget, allowlist, expiry, vault state" : "PayGuard proof pipeline"}</span></span><span className="pss-status">{step > i + 1 ? "Done" : step === i + 1 ? "Running" : "Waiting"}</span></div>)}</div>;
}

function ResultCard({ proof }: { proof: any }) {
  const approved = Boolean(proof.approved);
  return <div className={`result-card show ${approved ? "approved" : "blocked"}`}><div className="rc-icon">{approved ? <CheckCircle2 /> : <XCircle />}</div><span><div className="rc-title">{approved ? "Payment approved" : "Payment blocked"}</div><div className="rc-sub">{approved ? `Receipt ${proof.receiptVerified ? "verified" : "pending"} - ${proof.mode}` : `${violationName(proof.violation)} - no funds move.`}</div></span><code className="rc-hash">Digest: {String(proof.journalDigest).slice(0, 10)}...<br />Image: {String(proof.imageId || env.risc0ImageId).slice(0, 10)}...</code></div>;
}

function violationName(code: number) {
  return ({ [ViolationCode.None]: "-", [ViolationCode.MaxPayment]: "max_per_tx", [ViolationCode.DailyLimit]: "daily_limit", [ViolationCode.Allowlist]: "allowlist", [ViolationCode.Expired]: "expired", [ViolationCode.InsufficientVault]: "insufficient_vault" } as Record<number, string>)[code] ?? "unknown";
}

function Policies({
  policy,
  policyHash,
  setView,
  setPolicy,
  setInitialVault,
  revokePolicy,
  vaultBalance
}: {
  policy: PolicyDefinition | null;
  policyHash: string;
  setView: (view: View) => void;
  setPolicy: (p: PolicyDefinition) => void;
  setInitialVault: (v: string) => void;
  revokePolicy: () => void;
  vaultBalance: string;
}) {
  const isActive = Number(vaultBalance) > 0;

  const handleNewPolicy = () => {
    setPolicy({
      name: "",
      maxPerPayment: "",
      dailyLimit: "",
      allowlist: [],
      expiry: "",
      salt: `salt-${Math.random().toString(36).substring(2, 10)}`
    });
    setInitialVault("");
    setView("policy-builder");
  };

  const handleEdit = () => {
    if (policy) {
      setPolicy(policy);
      setInitialVault(vaultBalance);
      setView("policy-builder");
    }
  };

  return (
    <div id="page-policies">
      <div style={{ marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: "600", color: "var(--ink)" }}>My policies</div>
          <div style={{ fontSize: "12px", color: "var(--ink4)", marginTop: "2px" }}>
            {policy ? (isActive ? "1 active policy on Stellar testnet" : "0 active policies on Stellar testnet") : "0 active policies on Stellar testnet"}
          </div>
        </div>
        <button className="btn-sm primary" onClick={handleNewPolicy}>+ New policy</button>
      </div>

      {policy ? (
        <div className="card">
          <div className="feed-row" style={{ cursor: "default", padding: "16px 18px", alignItems: "flex-start", gap: "14px" }}>
            <div style={{ width: "40px", height: "40px", background: "var(--amber-bg)", borderRadius: "10px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: "18px" }}>
              🔒
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "14px", fontWeight: "600", color: "var(--ink)", marginBottom: "3px" }}>{policy.name || "Unnamed Policy"}</div>
              <div style={{ fontSize: "12px", color: "var(--ink4)", fontFamily: "var(--mono)", marginBottom: "8px" }}>
                Deployed Jun 27 · Expires {policy.expiry || "No expiry"}
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <span className={`sc-badge ${isActive ? "green" : "red"}`}>● {isActive ? "Active" : "Inactive"}</span>
                {policy.maxPerPayment && (
                  <span style={{ fontSize: "11px", background: "var(--c2)", color: "var(--ink3)", padding: "3px 8px", borderRadius: "6px", border: "1px solid var(--c3)", fontFamily: "var(--mono)" }}>
                    ≤${policy.maxPerPayment}/tx
                  </span>
                )}
                {policy.dailyLimit && (
                  <span style={{ fontSize: "11px", background: "var(--c2)", color: "var(--ink3)", padding: "3px 8px", borderRadius: "6px", border: "1px solid var(--c3)", fontFamily: "var(--mono)" }}>
                    ≤${policy.dailyLimit}/day
                  </span>
                )}
                <span style={{ fontSize: "11px", background: "var(--c2)", color: "var(--ink3)", padding: "3px 8px", borderRadius: "6px", border: "1px solid var(--c3)", fontFamily: "var(--mono)" }}>
                  {policy.allowlist.length} {policy.allowlist.length === 1 ? "vendor" : "vendors"}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button className="btn-sm ghost" onClick={handleEdit} style={{ fontSize: "12px" }}>Edit</button>
              <button className="btn-sm danger" onClick={revokePolicy} style={{ fontSize: "12px" }}>Revoke</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px", background: "var(--white)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", textAlign: "center" }}>
          <span style={{ fontSize: "40px", marginBottom: "12px" }}>📋</span>
          <div style={{ fontSize: "16px", fontWeight: "700", color: "var(--ink)", marginBottom: "4px" }}>No policies found</div>
          <div style={{ fontSize: "13px", color: "var(--ink3)", maxWidth: "340px", lineHeight: "1.6", marginBottom: "20px" }}>
            Create and deploy a private spending policy to delegate payments to your AI agents safely.
          </div>
          <button className="btn-sm primary" onClick={handleNewPolicy}>
            Create policy
          </button>
        </div>
      )}
    </div>
  );
}

function ProofLog({ events, notify }: { events: EventRow[]; notify: (m: string) => void }) {
  const [filter, setFilter] = useState<"all" | "verified" | "blocked">("all");

  const allCount = events.length;
  const verifiedCount = events.filter((e) => e.status === "VERIFIED").length;
  const blockedCount = events.filter((e) => e.status === "BLOCKED").length;

  const filteredEvents = events.filter((e) => {
    if (filter === "verified") return e.status === "VERIFIED";
    if (filter === "blocked") return e.status === "BLOCKED";
    return true;
  });

  const csv = [
    "Time,Recipient,Amount,Status,Violation,Proof,TxHash",
    ...events.map((e) => [e.time, e.recipient, e.amount, e.status, e.violation, e.proof, e.txHash ?? ""].join(","))
  ].join("\n");

  function download() {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "payguard-proof-log.csv";
    a.click();
    URL.revokeObjectURL(url);
    notify("Proof log exported as CSV");
  }

  return (
    <div id="page-proof-log">
      <div className="log-filters">
        <button
          className={`filter-btn ${filter === "all" ? "active" : ""}`}
          onClick={() => setFilter("all")}
        >
          All ({allCount})
        </button>
        <button
          className={`filter-btn ${filter === "verified" ? "active" : ""}`}
          onClick={() => setFilter("verified")}
        >
          Verified ({verifiedCount})
        </button>
        <button
          className={`filter-btn ${filter === "blocked" ? "active" : ""}`}
          onClick={() => setFilter("blocked")}
        >
          Blocked ({blockedCount})
        </button>
        <button className="btn-sm ghost" onClick={download} style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M7 1v9M4 7l3 3 3-3M1 11v1a1 1 0 001 1h10a1 1 0 001-1v-1" />
          </svg>
          Export CSV
        </button>
      </div>

      <div className="card" style={{ overflow: "auto" }}>
        <table className="log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Recipient</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Violation</th>
              <th>Proof digest</th>
              <th>Tx hash</th>
            </tr>
          </thead>
          <tbody>
            {filteredEvents.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: "40px 14px", color: "var(--ink4)" }}>
                  No logs matching the filter.
                </td>
              </tr>
            ) : (
              filteredEvents.map((e) => (
                <tr key={e.id}>
                  <td className="td-mono">{e.time}</td>
                  <td className="td-mono">{shortAddress(e.recipient)}</td>
                  <td style={{ fontWeight: "700", color: e.status === "BLOCKED" ? "var(--red)" : "var(--ink)" }}>
                    ${e.amount} USDC
                  </td>
                  <td>
                    <span className={`sc-badge ${e.status === "VERIFIED" ? "green" : "red"}`} style={{ padding: "3px 8px", borderRadius: "6px", fontSize: "11px", fontWeight: "600" }}>
                      {e.status}
                    </span>
                  </td>
                  <td>
                    {e.status === "BLOCKED" ? (
                      <span style={{ fontSize: "11px", background: "var(--red-bg)", color: "var(--red)", padding: "3px 8px", borderRadius: "6px", border: "1px solid rgba(239, 68, 68, 0.15)", fontFamily: "var(--mono)" }}>
                        {e.violation}
                      </span>
                    ) : (
                      <span style={{ fontSize: "11px", background: "var(--c2)", color: "var(--ink4)", padding: "3px 8px", borderRadius: "6px", border: "1px solid var(--c3)", fontFamily: "var(--mono)" }}>
                        -
                      </span>
                    )}
                  </td>
                  <td className="td-mono">{e.proof}</td>
                  <td>
                    {e.txHash ? (
                      <a className="td-link" href={stellarExpertTx(e.txHash)} target="_blank" rel="noreferrer" style={{ fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "2px" }}>
                        View ↗
                      </a>
                    ) : (
                      <span style={{ color: "var(--ink4)" }}>-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Settings({ wallet, disconnect, health, api }: { wallet: { address: string; network: string } | null; disconnect: () => void; health: { ok: boolean; status: string; ledger: number | null }; api: ApiStatus }) {
  return <div className="settings-col"><section className="card"><div className="card-header"><span className="card-title">Wallet and network</span></div><div className="card-body"><div className="settings-row"><span><b>Connected wallet</b><small>{wallet ? `${shortAddress(wallet.address)} (Freighter)` : "connect from the wallet overlay"}</small></span>{wallet && <button className="btn-sm danger" onClick={disconnect}>Disconnect</button>}</div><div className="settings-row"><span><b>Network</b><small>{env.network}</small></span><span className="sc-badge green">Testnet</span></div><div className="settings-row"><span><b>RPC</b><small>{health.ledger ? `ledger ${health.ledger}` : health.status}</small></span><span className={`sc-badge ${health.ok ? "green" : "red"}`}>{health.status}</span></div><div className="settings-row"><span><b>OpenAI API</b><small>{api.openai ? "server key configured" : "deterministic fallback active"}</small></span><span className={`sc-badge ${api.openai ? "green" : "amber"}`}>{api.openai ? "Live" : "Fallback"}</span></div></div></section><section className="card"><div className="card-header"><span className="card-title">Contracts</span></div><div className="card-body"><div className="settings-row"><span><b>PayGuard Gatekeeper</b><small><a className="td-link" href={contractLink(api.contractId)} target="_blank" rel="noreferrer">{api.contractId || "not configured"}</a></small></span></div><div className="settings-row"><span><b>RISC Zero Groth16 verifier</b><small><a className="td-link" href={contractLink(api.verifierContractId)} target="_blank" rel="noreferrer">{api.verifierContractId || "not configured"}</a></small></span></div><div className="settings-row"><span><b>RISC Zero image</b><small>{env.risc0ImageId || "not configured"}</small></span><span className={`sc-badge ${api.realProverConfigured ? "green" : "amber"}`}>{api.realProverConfigured ? "Groth16" : "Env"}</span></div><div className="settings-row"><span><b>Token contract</b><small>{api.tokenContractId || "not configured"}</small></span></div></div></section></div>;
}
