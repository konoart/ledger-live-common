import type { AccountLike, Account, TransactionStatus } from "../../types";
import type { Transaction } from "./types";
import type { DeviceTransactionField } from "../../transaction";

function getDeviceTransactionConfig({
  status: { amount, estimatedFees },
  transaction,
}: {
  account: AccountLike;
  parentAccount: Account | null | undefined;
  transaction: Transaction;
  status: TransactionStatus;
}): Array<DeviceTransactionField> {
  const fields: Array<DeviceTransactionField> = [];

  if (transaction.useAllAmount) {
    fields.push({
      type: "text",
      label: "Method",
      value: "Transfer All",
    });
  } else {
    fields.push({
      type: "text",
      label: "Method",
      value: "Transfer",
    });
    fields.push({
      type: "amount",
      label: "Amount",
    });
  }

  fields.push({
    type: "fees",
    label: "Fees",
  });

  return fields;
}

export default getDeviceTransactionConfig;
