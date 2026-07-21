import {
  Address as AddressSchema,
  type ParamsSpec,
  PositiveDecimalString,
  TokenReference,
} from "@themoss/core";
import { z } from "zod/v4";

/** Aave interest rate mode: 1 = stable, 2 = variable (default). */
export const InterestRateMode = z.coerce
  .number()
  .int()
  .refine(
    (value) => value === 1 || value === 2,
    "interestRateMode must be 1 (stable) or 2 (variable)",
  )
  .describe("Aave interest rate mode: 1 = stable, 2 = variable.");

export const EModeCategoryId = z.coerce
  .number()
  .int()
  .min(0)
  .max(255)
  .describe("Aave eMode category id; 0 disables eMode.");

export const BoolFlag = z.boolean().describe("Boolean flag.");

export const amountParams = {
  asset: { type: TokenReference, description: "ERC-20 asset (not native MON)." },
  amount: {
    type: PositiveDecimalString,
    description: 'Quantity in display units, such as "10" or "0.001".',
  },
} satisfies ParamsSpec;

export const supplyParams = {
  asset: { type: TokenReference, description: "ERC-20 asset to supply (not native MON)." },
  amount: {
    type: PositiveDecimalString,
    description: 'Quantity of the asset in display units, such as "10" or "0.001".',
  },
} satisfies ParamsSpec;

export const withdrawParams = {
  asset: { type: TokenReference, description: "ERC-20 asset to withdraw (not native MON)." },
  amount: {
    type: PositiveDecimalString,
    description: 'Quantity in display units (e.g. "0.001").',
  },
  to: { type: AddressSchema, description: "Address that receives the withdrawn underlying." },
} satisfies ParamsSpec;

export const borrowParams = {
  asset: { type: TokenReference, description: "ERC-20 asset to borrow (not native MON)." },
  amount: {
    type: PositiveDecimalString,
    description: 'Quantity to borrow in display units, such as "0.1".',
  },
  interestRateMode: {
    type: InterestRateMode.default(2),
    description: "1 = stable rate, 2 = variable rate (recommended default).",
  },
} satisfies ParamsSpec;

export const repayParams = {
  asset: { type: TokenReference, description: "ERC-20 debt asset to repay (not native MON)." },
  amount: {
    type: PositiveDecimalString,
    description: 'Quantity to repay in display units, such as "0.1".',
  },
  interestRateMode: {
    type: InterestRateMode.default(2),
    description: "1 = stable rate, 2 = variable rate (must match the debt).",
  },
} satisfies ParamsSpec;

export const collateralParams = {
  asset: { type: TokenReference, description: "ERC-20 reserve to toggle as collateral." },
  useAsCollateral: {
    type: BoolFlag,
    description: "True to enable the asset as collateral; false to disable.",
  },
} satisfies ParamsSpec;

export const eModeParams = {
  categoryId: {
    type: EModeCategoryId,
    description: "eMode category id; use 0 to disable eMode.",
  },
} satisfies ParamsSpec;

export const accountParams = {
  user: { type: AddressSchema, description: "User address whose Neverland account is read." },
} satisfies ParamsSpec;

export const reserveParams = {
  asset: {
    type: TokenReference,
    description: "Underlying ERC-20 reserve (not native MON).",
  },
} satisfies ParamsSpec;

export const userReserveParams = {
  asset: { type: TokenReference, description: "Underlying ERC-20 reserve." },
  user: { type: AddressSchema, description: "User whose reserve position is read." },
} satisfies ParamsSpec;
