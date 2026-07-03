export const USDC_DECIMALS = 7n;
export const USDC_SCALE = 10_000_000n;

export type RiskLevel = "low" | "medium" | "high";
export type PaymentCategory = "api" | "vendor" | "contractor" | "subscription" | "other";

export type PolicyDefinition = {
  name: string;
  maxPerPayment: string;
  dailyLimit: string;
  allowlist: string[];
  expiry: string;
  salt: string;
};

export type PaymentIntent = {
  recipient: string;
  amount: string;
  asset: "USDC";
  category: PaymentCategory;
  memo: string;
  rationale: string;
  riskLevel: RiskLevel;
};

export type Decision = {
  approved: boolean;
  violation: ViolationCode;
  policyHash: string;
  intentDigest: string;
  journalDigest: string;
};

export enum ViolationCode {
  None = 0,
  MaxPayment = 1,
  DailyLimit = 2,
  Allowlist = 3,
  Expired = 4,
  InsufficientVault = 5
}

export function parseUsdc(value: string): bigint {
  const cleaned = value.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,7})?$/.test(cleaned)) {
    throw new Error(`Invalid USDC amount: ${value}`);
  }
  const [whole, frac = ""] = cleaned.split(".");
  return BigInt(whole) * USDC_SCALE + BigInt(frac.padEnd(7, "0"));
}

export function formatUsdc(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / USDC_SCALE;
  const frac = (abs % USDC_SCALE).toString().padStart(7, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

export function isLikelyStellarAddress(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value.trim());
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digestInput = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error("Invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function canonicalPolicy(policy: PolicyDefinition): string {
  const allowlist = [...new Set(policy.allowlist.map((x) => x.trim()).filter(Boolean))].sort();
  let maxPerPayment = "0";
  try {
    if (policy.maxPerPayment) {
      maxPerPayment = parseUsdc(policy.maxPerPayment).toString();
    }
  } catch {}
  let dailyLimit = "0";
  try {
    if (policy.dailyLimit) {
      dailyLimit = parseUsdc(policy.dailyLimit).toString();
    }
  } catch {}
  return JSON.stringify({
    name: (policy.name || "").trim(),
    maxPerPayment,
    dailyLimit,
    allowlist,
    expiry: policy.expiry || "",
    salt: policy.salt || ""
  });
}

export async function hashPolicy(policy: PolicyDefinition): Promise<string> {
  return sha256Hex(canonicalPolicy(policy));
}

export async function digestIntent(intent: PaymentIntent): Promise<string> {
  return sha256Hex(JSON.stringify({
    recipient: intent.recipient.trim(),
    amount: parseUsdc(intent.amount).toString(),
    asset: intent.asset,
    category: intent.category,
    memo: intent.memo.trim()
  }));
}

export async function evaluatePolicy(params: {
  policy: PolicyDefinition;
  intent: PaymentIntent;
  spentToday: string;
  vaultBalance: string;
  now?: Date;
}): Promise<Decision> {
  const policyHash = await hashPolicy(params.policy);
  const intentDigest = await digestIntent(params.intent);
  let amount = 0n;
  try { amount = parseUsdc(params.intent.amount); } catch {}
  let max = 0n;
  try { max = parseUsdc(params.policy.maxPerPayment); } catch {}
  let daily = 0n;
  try { daily = parseUsdc(params.policy.dailyLimit); } catch {}
  let spent = 0n;
  try { spent = parseUsdc(params.spentToday); } catch {}
  let vault = 0n;
  try { vault = parseUsdc(params.vaultBalance); } catch {}
  const now = params.now ?? new Date();
  const expiry = new Date(`${params.policy.expiry}T23:59:59Z`);
  let violation = ViolationCode.None;

  if (amount > max) violation = ViolationCode.MaxPayment;
  else if (spent + amount > daily) violation = ViolationCode.DailyLimit;
  else if (!params.policy.allowlist.includes(params.intent.recipient)) violation = ViolationCode.Allowlist;
  else if (Number.isFinite(expiry.getTime()) && now > expiry) violation = ViolationCode.Expired;
  else if (amount > vault) violation = ViolationCode.InsufficientVault;

  const journalDigest = await sha256Hex(JSON.stringify({
    policyHash,
    intentDigest,
    amount: amount.toString(),
    spentBefore: spent.toString(),
    spentAfter: violation === ViolationCode.None ? (spent + amount).toString() : spent.toString(),
    vaultBefore: vault.toString(),
    vaultAfter: violation === ViolationCode.None ? (vault - amount).toString() : vault.toString(),
    approved: violation === ViolationCode.None,
    violation
  }));

  return { approved: violation === ViolationCode.None, violation, policyHash, intentDigest, journalDigest };
}

export function shortAddress(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}
