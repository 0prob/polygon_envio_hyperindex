import {
  CURVE_REGISTRY_DEPLOY_BLOCK,
  CURVE_REGISTRY_LEGACY,
} from "../utils/constants";

/** Envio CurveRegistry bootstrap state id (chain-scoped). */
export const CURVE_BOOTSTRAP_LEGACY_ID = "137-legacy";

export const CURVE_REGISTRY_SOURCES = [
  { id: CURVE_BOOTSTRAP_LEGACY_ID, address: CURVE_REGISTRY_LEGACY, deployBlock: CURVE_REGISTRY_DEPLOY_BLOCK },
] as const;

/** HyperIndex Protocol enum value for Curve pools (subtype lives in poolType). */
export function curveDiscoveryProtocol(_poolType: string | undefined): "CURVE" {
  return "CURVE";
}
