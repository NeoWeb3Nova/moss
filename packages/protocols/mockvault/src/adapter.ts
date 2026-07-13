/**
 * MockVault — a deliberately tiny protocol adapter used to learn Moss.
 *
 * It exposes one capability (deposit native MON) and one query (balanceOf).
 * There is no real deployed contract behind MOCK_VAULT_ADDRESS; this package
 * is only for offline shape tests and adapter-authoring practice.
 */
import {
  type Address,
  address,
  Capability,
  type DecodedEvent,
  Event,
  type Handle,
  NATIVE,
  nativeAmount,
  type ObserveCtx,
  Protocol,
  plan,
  Query,
} from "@themoss/core";
import { MockVaultAbi } from "./abis/mockvault.js";

export const MOCK_VAULT_ADDRESS: Address = "0x0000000000000000000000000000000000000001";

@Protocol({
  name: "mockvault",
  category: "token",
  description: "A toy vault that accepts native MON deposits for learning Moss adapter authoring.",
  contracts: {
    vault: { abi: MockVaultAbi, addr: MOCK_VAULT_ADDRESS },
  },
})
export class MockVault {
  declare vault: Handle<typeof MockVaultAbi>;

  @Capability({
    intent: "Deposit {amount} native MON into the mock vault",
    verb: "supply",
    params: { amount: nativeAmount },
    risk: ["fundOut"],
    tags: ["example", "learning"],
    confirms: ["depositReceipt"],
  })
  async deposit({ amount }: { amount: bigint }) {
    const step = this.vault.deposit([], { value: amount });
    return plan([step], {
      out: [{ token: NATIVE, amountMax: amount }],
    });
  }

  @Event<MockVault>({
    events: { vault: ["Deposited"] },
    intent: "Deposited {amount} MON into the mock vault",
  })
  async depositReceipt(events: DecodedEvent[], ctx: ObserveCtx) {
    const hit = events.find((e) => e.name === "Deposited");
    if (!hit) return null;
    const { amount } = hit.args as { account: Address; amount: bigint };
    return { amount: (await ctx.token(NATIVE)).format(amount) };
  }

  @Query({
    intent: "Mock vault balance of {owner}",
    params: { owner: address },
  })
  async balanceOf({ owner }: { owner: Address }) {
    const balance = await this.vault.read.balanceOf([owner]);
    return { balance: balance.toString() };
  }
}
