import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from "viem";

/**
 * Classifies an RPC error into a human-readable reason + permanent-vs-transient flag.
 *
 * Permanent errors (contract doesn't implement interface, reverted, bad input) →
 *   cache the failure so the effect is never retried.
 * Transient errors (rate limit, network, timeout) →
 *   don't cache; the effect will retry on the next handler execution.
 *
 * Called from every effect's error path (token decimals, Curve/Balancer/DODO/Algebra/WooFi
 * metadata). Runs inside the Envio effect worker (not the hot handler path).
 */
export function classifyRpcError(err: unknown): {
  reason: string;
  isPermanent: boolean;
} {
  const errStr = String(err);
  const isBaseError = err instanceof BaseError;
  const rz = isBaseError
    ? err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null
    : false;
  const rr = isBaseError
    ? err.walk((e) => e instanceof ContractFunctionRevertedError) !== null
    : false;
  const isZeroData =
    err instanceof ContractFunctionZeroDataError || rz;
  const isReverted =
    err instanceof ContractFunctionRevertedError || rr;
  const isMalformedInput =
    errStr.includes("Invalid address") ||
    errStr.includes("odd length") ||
    errStr.includes("cannot unmarshal");

  if (isZeroData) {
    return {
      reason:
        "ZERO_DATA: Contract exists but does not implement the expected interface.",
      isPermanent: true,
    };
  }
  if (isReverted) {
    return {
      reason:
        "REVERTED: Contract call reverted — contract likely deprecated or not the expected type.",
      isPermanent: true,
    };
  }
  if (isMalformedInput) {
    return {
      reason: "MALFORMED_INPUT: Invalid or corrupted address.",
      isPermanent: true,
    };
  }

  const msg = errStr.toLowerCase();
  if (
    msg.includes("monthly") ||
    msg.includes("capacity") ||
    msg.includes("quota") ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  ) {
    return {
      reason: "RATE_LIMITED: RPC endpoint throttled the request. Will retry.",
      isPermanent: false,
    };
  }
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("failed to fetch") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("http request failed") ||
    /\b50[0-9]\b/.test(msg)
  ) {
    return {
      reason: "NETWORK_ERROR: RPC connection failed or timed out. Will retry.",
      isPermanent: false,
    };
  }

  return {
    reason: `FETCH_FAILED: ${errStr.slice(0, 200)}`,
    isPermanent: false,
  };
}
