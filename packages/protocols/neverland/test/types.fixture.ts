import type { ActionCtx, InferParams, ParamsSpec, ProtocolRef } from "@themoss/core";
import { PositiveDecimalString, TokenReference } from "@themoss/core";
import { USDC_ADDRESS } from "@themoss/system";
import type { Neverland } from "../src/index.js";

const supplyParams = {
  asset: { type: TokenReference, description: "Asset." },
  amount: { type: PositiveDecimalString, description: "Amount." },
} satisfies ParamsSpec;

declare const neverland: Neverland;
declare const ctx: ActionCtx;
declare const dependency: ProtocolRef<Neverland>;

void neverland.supply({ asset: USDC_ADDRESS, amount: "1" }, ctx);
void neverland.withdraw({ asset: USDC_ADDRESS, amount: "1", to: USDC_ADDRESS }, ctx);
void neverland.accountData({ user: USDC_ADDRESS });
void neverland.supplyReceipt([]);
void neverland.withdrawReceipt([]);

const validSupply: InferParams<typeof supplyParams> = { asset: USDC_ADDRESS, amount: "1" };
void neverland.supply(validSupply, ctx);

// @ts-expect-error amount must be a decimal string, not a number
const badAmount: InferParams<typeof supplyParams> = { asset: USDC_ADDRESS, amount: 1 };
void badAmount;

// @ts-expect-error ProtocolRef exposes methods, not contract Handles
void dependency.pool;

// Injected dependency Capabilities / Receipts are callable.
void dependency.supply;
void dependency.supplyReceipt;
