import * as StellarSdk from "@stellar/stellar-sdk";
import {
  getAddress,
  getNetwork,
  isConnected,
  requestAccess,
  signTransaction
} from "@stellar/freighter-api";

export const env = {
  apiUrl: import.meta.env.VITE_PAYGUARD_API_URL ?? "http://localhost:8787",
  network: import.meta.env.VITE_STELLAR_NETWORK ?? "testnet",
  rpcUrl: import.meta.env.VITE_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
  horizonUrl: import.meta.env.VITE_STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
  contractId: import.meta.env.VITE_PAYGUARD_CONTRACT_ID ?? "",
  tokenContractId: import.meta.env.VITE_PAYGUARD_TOKEN_CONTRACT_ID ?? ""
};

export const rpc = new StellarSdk.rpc.Server(env.rpcUrl);
export const horizon = new StellarSdk.Horizon.Server(env.horizonUrl);
export const networkPassphrase = env.network === "mainnet"
  ? StellarSdk.Networks.PUBLIC
  : StellarSdk.Networks.TESTNET;

export async function connectFreighter(): Promise<{ address: string; network: string }> {
  const connected = await isConnected();
  if (!connected.isConnected) throw new Error("Freighter is not installed or unavailable.");
  const access = await requestAccess();
  if (access.error) throw new Error(access.error.message);
  const net = await getNetwork();
  if (net.error) throw new Error(net.error.message);
  return { address: access.address, network: net.network };
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
  const signed = await signTransaction(xdr, { networkPassphrase });
  if (signed.error) throw new Error(signed.error.message);
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
