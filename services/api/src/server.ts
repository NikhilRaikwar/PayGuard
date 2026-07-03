import "dotenv/config";
import cors from "cors";
import express from "express";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  evaluatePolicy,
  isLikelyStellarAddress,
  parseUsdc,
  type PaymentIntent,
  type PolicyDefinition
} from "@payguard/protocol";

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const category = z.enum(["api", "vendor", "contractor", "subscription", "other"]);
const risk = z.enum(["low", "medium", "high"]);

const intentSchema = z.object({
  recipient: z.string(),
  amount: z.string(),
  asset: z.literal("USDC").default("USDC"),
  category,
  memo: z.string().max(120).default(""),
  rationale: z.string().max(800),
  riskLevel: risk
});

const policySchema = z.object({
  name: z.string(),
  maxPerPayment: z.string(),
  dailyLimit: z.string(),
  allowlist: z.array(z.string()),
  expiry: z.string(),
  salt: z.string()
});

const proofJobs = new Map<string, {
  id: string;
  status: "queued" | "proving" | "complete" | "failed";
  createdAt: string;
  result?: unknown;
  error?: string;
}>();

type ProverOutput = {
  approved: boolean;
  violation: number;
  policyHash: string;
  intentDigest: string;
  journalDigest: string;
  imageId: string;
  sealHex: string;
  receiptJournalHex?: string;
  receiptVerified: boolean;
  mode: string;
};

app.get("/v1/health", (_req, res) => {
  res.json({
    ok: true,
    service: "payguard-api",
    network: process.env.STELLAR_NETWORK ?? "testnet",
    openai: Boolean(process.env.OPENAI_API_KEY),
    realProverConfigured: Boolean(process.env.PAYGUARD_REAL_PROVER_CMD)
  });
});

app.get("/v1/config", (_req, res) => {
  res.json({
    network: process.env.STELLAR_NETWORK ?? "testnet",
    rpcUrl: process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    contractId: process.env.PAYGUARD_CONTRACT_ID ?? "",
    verifierContractId: process.env.PAYGUARD_VERIFIER_CONTRACT_ID ?? "",
    tokenContractId: process.env.PAYGUARD_TOKEN_CONTRACT_ID ?? "",
    realProverConfigured: Boolean(process.env.PAYGUARD_REAL_PROVER_CMD)
  });
});

app.post("/v1/agent/payment-intent", async (req, res) => {
  const body = z.object({
    prompt: z.string().min(3),
    allowlist: z.array(z.string()).default([]),
    aliases: z.record(z.string()).default({})
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ error: body.error.flatten() });

  try {
    const intent = await proposePaymentIntent(body.data.prompt, body.data.allowlist, body.data.aliases);
    const parsed = intentSchema.parse(intent);
    parseUsdc(parsed.amount);
    if (!isLikelyStellarAddress(parsed.recipient)) {
      return res.status(422).json({ error: "Agent returned an invalid Stellar recipient address." });
    }
    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to propose payment." });
  }
});

app.post("/v1/proofs", async (req, res) => {
  const body = z.object({
    policy: policySchema,
    intent: intentSchema,
    spentToday: z.string().default("0"),
    vaultBalance: z.string().default("0")
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ error: body.error.flatten() });

  const id = crypto.randomUUID();
  proofJobs.set(id, { id, status: "queued", createdAt: new Date().toISOString() });
  res.status(202).json({ id, status: "queued" });

  void runProofJob(id, body.data.policy, body.data.intent, body.data.spentToday, body.data.vaultBalance);
});

app.get("/v1/proofs/:jobId", (req, res) => {
  const job = proofJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Proof job not found." });
  res.json(job);
});

async function proposePaymentIntent(prompt: string, allowlist: string[], aliases: Record<string, string>): Promise<PaymentIntent> {
  if (process.env.OPENAI_API_KEY) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: "Return only JSON for a Stellar USDC payment intent. Do not invent recipients outside supplied aliases or allowlist."
          },
          {
            role: "user",
            content: JSON.stringify({ prompt, allowlist, aliases })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "payment_intent",
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["recipient", "amount", "asset", "category", "memo", "rationale", "riskLevel"],
              properties: {
                recipient: { type: "string" },
                amount: { type: "string" },
                asset: { type: "string", enum: ["USDC"] },
                category: { type: "string", enum: ["api", "vendor", "contractor", "subscription", "other"] },
                memo: { type: "string" },
                rationale: { type: "string" },
                riskLevel: { type: "string", enum: ["low", "medium", "high"] }
              }
            }
          }
        }
      })
    });
    if (!response.ok) throw new Error(`OpenAI request failed: ${response.status}`);
    const json = await response.json();
    const outputText = extractOpenAiText(json);
    if (!outputText) throw new Error("OpenAI response did not include parseable output text.");
    return JSON.parse(outputText) as PaymentIntent;
  }

  return heuristicIntent(prompt, allowlist, aliases);
}

function heuristicIntent(prompt: string, allowlist: string[], aliases: Record<string, string>): PaymentIntent {
  const lower = prompt.toLowerCase();
  const amount = lower.match(/(\d+(?:\.\d+)?)\s*(?:usdc|usd|\$)/i)?.[1] ?? "30";
  const alias = Object.keys(aliases).find((key) => lower.includes(key.toLowerCase()));
  const fallbackRecipient = allowlist[0] ?? "GBTZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAX4K2";
  const recipient = alias ? aliases[alias] : lower.includes("unknown") || lower.includes("unapproved")
    ? "GYYYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP9Q2"
    : fallbackRecipient;
  const category: PaymentIntent["category"] = lower.includes("api") ? "api"
    : lower.includes("contractor") || lower.includes("design") ? "contractor"
    : lower.includes("subscription") ? "subscription"
    : "vendor";
  const riskLevel: PaymentIntent["riskLevel"] = allowlist.includes(recipient) ? "low" : "high";

  return {
    recipient,
    amount,
    asset: "USDC",
    category,
    memo: `PayGuard intent: ${category}`,
    rationale: riskLevel === "low"
      ? `Recipient is allowlisted and the requested ${amount} USDC payment can be checked against the private policy.`
      : `Recipient is not currently allowlisted, so the ZK policy proof should produce a verified denial.`,
    riskLevel
  };
}

function extractOpenAiText(json: unknown): string {
  if (typeof json !== "object" || json === null) return "";
  const maybe = json as { output_text?: unknown; output?: unknown };
  if (typeof maybe.output_text === "string") return maybe.output_text;
  if (!Array.isArray(maybe.output)) return "";
  for (const item of maybe.output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return "";
}

async function runProofJob(
  id: string,
  policy: PolicyDefinition,
  intent: PaymentIntent,
  spentToday: string,
  vaultBalance: string
) {
  proofJobs.set(id, { ...proofJobs.get(id)!, status: "proving" });
  try {
    const proofDate = new Date();
    const decision = await evaluatePolicy({ policy, intent, spentToday, vaultBalance, now: proofDate });
    const realProver = process.env.PAYGUARD_REAL_PROVER_CMD;
    const prover = realProver
      ? await runExternalProver(realProver, { policy, intent, spentToday, vaultBalance, proofDate: proofDate.toISOString().slice(0, 10) })
      : null;

    if (prover) {
      assertSameDecision(decision, prover);
    }

    proofJobs.set(id, {
      ...proofJobs.get(id)!,
      status: "complete",
      result: {
        ...(prover ?? decision),
        mode: prover?.mode ?? "dev-policy-evaluator",
        sealHex: prover?.sealHex ?? "dev-only-no-seal",
        imageId: prover?.imageId ?? process.env.PAYGUARD_RISC0_IMAGE_ID ?? "",
        receiptVerified: prover?.receiptVerified ?? false,
        warning: prover
          ? "RISC Zero receipt was produced and verified off-chain. Stellar testnet uses the attestation-verifier contract until native BN254 verification lands."
          : "Development evaluator only. Set PAYGUARD_REAL_PROVER_CMD=scripts/prove-risc0.sh for the real RISC Zero prover."
      }
    });
  } catch (error) {
    proofJobs.set(id, {
      ...proofJobs.get(id)!,
      status: "failed",
      error: error instanceof Error ? error.message : "Proof generation failed."
    });
  }
}

async function runExternalProver(command: string, input: unknown): Promise<ProverOutput> {
  const timeoutMs = Number(process.env.PAYGUARD_PROVER_TIMEOUT_MS ?? 180_000);
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env }
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`RISC Zero prover timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`RISC Zero prover exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as ProverOutput;
        if (!parsed.receiptVerified) throw new Error("Prover did not report a verified receipt.");
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Invalid RISC Zero prover output: ${error instanceof Error ? error.message : "parse failed"}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function assertSameDecision(expected: Awaited<ReturnType<typeof evaluatePolicy>>, actual: ProverOutput) {
  const mismatches = [
    ["approved", String(expected.approved), String(actual.approved)],
    ["violation", String(expected.violation), String(actual.violation)],
    ["policyHash", expected.policyHash, actual.policyHash],
    ["intentDigest", expected.intentDigest, actual.intentDigest],
    ["journalDigest", expected.journalDigest, actual.journalDigest]
  ].filter(([, a, b]) => a !== b);
  if (mismatches.length > 0) {
    throw new Error(`RISC Zero prover output mismatch: ${mismatches.map(([key]) => key).join(", ")}`);
  }
}

app.listen(port, () => {
  console.log(`PayGuard API listening on http://localhost:${port}`);
});
