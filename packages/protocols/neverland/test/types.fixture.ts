import type { ActionCtx, ProtocolRef } from "@themoss/core";
import { USDC_ADDRESS } from "@themoss/system";
import type { Neverland } from "../src/index.js";

declare const neverland: Neverland;
declare const ctx: ActionCtx;
declare const dependency: ProtocolRef<Neverland>;

void neverland.supply({ asset: USDC_ADDRESS, amount: "1" }, ctx);
void neverland.withdraw({ asset: USDC_ADDRESS, amount: "1", to: USDC_ADDRESS }, ctx);
void neverland.borrow({ asset: USDC_ADDRESS, amount: "0.1", interestRateMode: 2 as const }, ctx);
void neverland.repay({ asset: USDC_ADDRESS, amount: "0.1", interestRateMode: 2 as const }, ctx);
void neverland.setCollateral({ asset: USDC_ADDRESS, useAsCollateral: true }, ctx);
void neverland.setEMode({ categoryId: 0 }, ctx);
void neverland.accountData({ user: USDC_ADDRESS });
void neverland.reserveTokens({ asset: USDC_ADDRESS });
void neverland.userReserveData({ asset: USDC_ADDRESS, user: USDC_ADDRESS });
void neverland.reserveConfig({ asset: USDC_ADDRESS });
void neverland.reservesList();
void neverland.supplyReceipt([]);
void neverland.borrowReceipt([]);
void neverland.repayReceipt([]);
void neverland.collateralReceipt([]);
void neverland.eModeReceipt([]);

// @ts-expect-error ProtocolRef exposes methods, not contract Handles
void dependency.pool;

void dependency.borrow;
void dependency.repay;
void dependency.setCollateral;
