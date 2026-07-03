import * as StellarSdk from "@stellar/stellar-sdk";
import {
  getAddress,
  getNetwork,
  isConnected,
  requestAccess,
  signTransaction
} from "@stellar/freighter-api";
import { StellarWalletsKit, Networks } from "@creit.tech/stellar-wallets-kit";
import { FreighterModule, FREIGHTER_ID } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";

export const env = {
  apiUrl: import.meta.env.VITE_PAYGUARD_API_URL ?? "http://localhost:8787",
  network: import.meta.env.VITE_STELLAR_NETWORK ?? "testnet",
  rpcUrl: import.meta.env.VITE_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
  horizonUrl: import.meta.env.VITE_STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
  contractId: import.meta.env.VITE_PAYGUARD_CONTRACT_ID ?? "",
  verifierContractId: import.meta.env.VITE_PAYGUARD_VERIFIER_CONTRACT_ID ?? "",
  risc0ImageId: import.meta.env.VITE_PAYGUARD_RISC0_IMAGE_ID ?? "",
  tokenContractId: import.meta.env.VITE_PAYGUARD_TOKEN_CONTRACT_ID ?? ""
};

export const rpc = new StellarSdk.rpc.Server(env.rpcUrl);
export const horizon = new StellarSdk.Horizon.Server(env.horizonUrl);
export const networkPassphrase = env.network === "mainnet"
  ? StellarSdk.Networks.PUBLIC
  : StellarSdk.Networks.TESTNET;

let kitInitialized = false;
export function initWalletKit() {
  if (kitInitialized) return;
  StellarWalletsKit.init({
    network: env.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
    modules: [
      new FreighterModule(),
      new LobstrModule(),
      new xBullModule()
    ]
  });
  kitInitialized = true;
}

export async function connectFreighter(): Promise<{ address: string; network: string }> {
  initWalletKit();
  const result = await StellarWalletsKit.authModal();
  let networkName = "testnet";
  try {
    const net = await StellarWalletsKit.getNetwork();
    if (net && net.networkPassphrase && net.networkPassphrase.includes("Public")) {
      networkName = "mainnet";
    }
  } catch {
    // fallback
  }
  return { address: result.address, network: networkName };
}

export async function restoreFreighter(): Promise<{ address: string; network: string } | null> {
  const connected = await isConnected();
  if (!connected.isConnected) return null;
  const address = await getAddress();
  if (address.error || !address.address) return null;
  const network = await getNetwork();
  if (network.error) return null;
  return { address: address.address, network: network.network };
}

export async function rpcHealth() {
  try {
    const health = await rpc.getHealth();
    const ledger = await rpc.getLatestLedger();
    return { ok: health.status === "healthy", status: health.status, ledger: ledger.sequence };
  } catch (error) {
    return { ok: false, status: error instanceof Error ? error.message : "offline", ledger: null };
  }
}

export async function apiStatus() {
  try {
    const [health, config] = await Promise.all([
      fetch(`${env.apiUrl}/v1/health`).then((r) => r.json()),
      fetch(`${env.apiUrl}/v1/config`).then((r) => r.json())
    ]);
    return {
      ok: true,
      openai: Boolean(health.openai),
      realProverConfigured: Boolean(health.realProverConfigured),
      contractId: config.contractId || env.contractId,
      verifierContractId: config.verifierContractId || env.verifierContractId,
      tokenContractId: config.tokenContractId || env.tokenContractId
    };
  } catch {
    return {
      ok: false,
      openai: false,
      realProverConfigured: false,
      contractId: env.contractId,
      verifierContractId: env.verifierContractId,
      tokenContractId: env.tokenContractId
    };
  }
}

export async function buildContractCall(params: {
  source: string;
  contractId: string;
  method: string;
  args: StellarSdk.xdr.ScVal[];
}) {
  const account = await rpc.getAccount(params.source);
  const contract = new StellarSdk.Contract(params.contractId);
  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase
  })
    .addOperation(contract.call(params.method, ...params.args))
    .setTimeout(180)
    .build();
  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  tx = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  return tx.toXDR();
}

export async function submitSignedXdr(signedXdr: string) {
  const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as StellarSdk.Transaction;
  const sent = await rpc.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(sent.errorResult?.toString() ?? "Transaction submission failed.");
  let result = await rpc.getTransaction(sent.hash);
  while (result.status === "NOT_FOUND") {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await rpc.getTransaction(sent.hash);
  }
  if (result.status !== "SUCCESS") throw new Error(`Transaction ${sent.hash} failed: ${result.status}`);
  return { hash: sent.hash, returnValue: result.returnValue ? StellarSdk.scValToNative(result.returnValue) : null };
}

export async function signAndSubmit(xdr: string) {
  initWalletKit();
  const signed = await StellarWalletsKit.signTransaction(xdr);
  if (!signed.signedTxXdr) throw new Error("Transaction signing failed or was cancelled.");
  return submitSignedXdr(signed.signedTxXdr);
}

export function stellarExpertTx(hash: string) {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

export function scAddress(value: string) {
  return StellarSdk.Address.fromString(value).toScVal();
}

export function scBytes32(hex: string) {
  const clean = hex.replace(/^0x/, "");
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(clean.padStart(64, "0").slice(0, 64), "hex"));
}

export function scI128(value: bigint) {
  return StellarSdk.nativeToScVal(value, { type: "i128" });
}

export async function getNetworkHash(): Promise<string> {
  const hash = StellarSdk.hash(Buffer.from(networkPassphrase));
  return hash.toString("hex");
}

export function buildJournalScVal(journal: {
  network_hash: string;
  gatekeeper: string;
  policy_id: string;
  policy_hash: string;
  token: string;
  executor: string;
  recipient: string;
  amount: bigint;
  day_index: bigint;
  spent_before: bigint;
  spent_after: bigint;
  vault_before: bigint;
  vault_after: bigint;
  nonce: bigint;
  proof_timestamp: bigint;
  approved: boolean;
  violation: number;
  intent_digest: string;
}) {
  const entries = [
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("amount", { type: "symbol" }),
      val: scI128(journal.amount)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("approved", { type: "symbol" }),
      val: StellarSdk.nativeToScVal(journal.approved, { type: "bool" })
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("day_index", { type: "symbol" }),
      val: StellarSdk.nativeToScVal(journal.day_index, { type: "u64" })
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("executor", { type: "symbol" }),
      val: scAddress(journal.executor)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("gatekeeper", { type: "symbol" }),
      val: scAddress(journal.gatekeeper)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("intent_digest", { type: "symbol" }),
      val: scBytes32(journal.intent_digest)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("network_hash", { type: "symbol" }),
      val: scBytes32(journal.network_hash)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("nonce", { type: "symbol" }),
      val: StellarSdk.nativeToScVal(journal.nonce, { type: "u64" })
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("policy_hash", { type: "symbol" }),
      val: scBytes32(journal.policy_hash)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("policy_id", { type: "symbol" }),
      val: scBytes32(journal.policy_id)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("proof_timestamp", { type: "symbol" }),
      val: StellarSdk.nativeToScVal(journal.proof_timestamp, { type: "u64" })
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("recipient", { type: "symbol" }),
      val: scAddress(journal.recipient)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("spent_after", { type: "symbol" }),
      val: scI128(journal.spent_after)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("spent_before", { type: "symbol" }),
      val: scI128(journal.spent_before)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("token", { type: "symbol" }),
      val: scAddress(journal.token)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("vault_after", { type: "symbol" }),
      val: scI128(journal.vault_after)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("vault_before", { type: "symbol" }),
      val: scI128(journal.vault_before)
    }),
    new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.nativeToScVal("violation", { type: "symbol" }),
      val: StellarSdk.nativeToScVal(journal.violation, { type: "u32" })
    })
  ];

  entries.sort((a, b) => {
    const keyA = StellarSdk.scValToNative(a.key()).toString();
    const keyB = StellarSdk.scValToNative(b.key()).toString();
    return keyA.localeCompare(keyB);
  });

  return StellarSdk.xdr.ScVal.scvMap(entries);
}

export async function executeDecision(params: {
  source: string;
  contractId: string;
  policyId: string;
  sealHex: string;
  journal: {
    network_hash: string;
    gatekeeper: string;
    policy_id: string;
    policy_hash: string;
    token: string;
    executor: string;
    recipient: string;
    amount: bigint;
    day_index: bigint;
    spent_before: bigint;
    spent_after: bigint;
    vault_before: bigint;
    vault_after: bigint;
    nonce: bigint;
    proof_timestamp: bigint;
    approved: boolean;
    violation: number;
    intent_digest: string;
  };
}) {
  const policyIdBytes = scBytes32(params.policyId);
  const executorBytes = scAddress(params.source);
  const sealBytes = StellarSdk.xdr.ScVal.scvBytes(Buffer.from(params.sealHex.replace(/^0x/, ""), "hex"));
  const journalVal = buildJournalScVal(params.journal);

  const xdr = await buildContractCall({
    source: params.source,
    contractId: params.contractId,
    method: "execute_decision",
    args: [policyIdBytes, executorBytes, sealBytes, journalVal]
  });

  return signAndSubmit(xdr);
}

export async function getPolicyState(policyId: string): Promise<any> {
  if (!env.contractId) throw new Error("PayGuard contract ID not configured.");
  const policyIdBytes = scBytes32(policyId);
  const dummySource = "GBZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM7R3";
  const contract = new StellarSdk.Contract(env.contractId);

  const account = new StellarSdk.Account(dummySource, "0");
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase
  })
    .addOperation(contract.call("get_policy", policyIdBytes))
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  if (!sim.result) {
    throw new Error("No simulation result returned.");
  }

  const val = sim.result.retval;
  return StellarSdk.scValToNative(val);
}

export async function getPolicyStats(policyId: string): Promise<any> {
  if (!env.contractId) throw new Error("PayGuard contract ID not configured.");
  const policyIdBytes = scBytes32(policyId);
  const dummySource = "GBZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM7R3";
  const contract = new StellarSdk.Contract(env.contractId);

  const account = new StellarSdk.Account(dummySource, "0");
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase
  })
    .addOperation(contract.call("get_stats", policyIdBytes))
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  if (!sim.result) {
    throw new Error("No simulation result returned.");
  }

  const val = sim.result.retval;
  return StellarSdk.scValToNative(val);
}
