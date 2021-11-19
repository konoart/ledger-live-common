import { makeScanAccounts, makeSync, mergeOps } from "../../bridge/jsHelpers";
import {
  Account,
  encodeAccountId,
  Operation,
  OperationType,
  TokenAccount,
} from "../../types";
import type { GetAccountShape } from "../../bridge/jsHelpers";
import { getAccount, findAssociatedTokenAccountPubkey } from "./api";
import BigNumber from "bignumber.js";

import { emptyHistoryCache } from "../../account";
import { getTransactions, TransactionDescriptor } from "./api/web3";
import { getTokenById } from "@ledgerhq/cryptoassets";
import { encodeOperationId } from "../../operation";
import {
  Awaited,
  encodeAccountIdWithTokenAccountAddress,
  tokenIsListedOnLedger,
  toTokenId,
  toTokenMint,
} from "./logic";
import _, { compact, filter, groupBy, keyBy, toPairs, pipe } from "lodash/fp";
import { parseQuiet } from "./api/program/parser";
import {
  ParsedConfirmedTransactionMeta,
  ParsedMessageAccount,
  ParsedTransaction,
} from "@solana/web3.js";

type OnChainTokenAccount = Awaited<
  ReturnType<typeof getAccount>
>["tokenAccounts"][number];

const getAccountShape: GetAccountShape = async (info) => {
  const {
    address: mainAccAddress,
    initialAccount: mainInitialAcc,
    currency,
    derivationMode,
  } = info;
  const {
    //TODO: switch to slot?
    blockHeight,
    balance: mainAccBalance,
    spendableBalance: mainAccSpendableBalance,
    tokenAccounts: onChaintokenAccounts,
  } = await getAccount(mainAccAddress);

  const mainAccountId = encodeAccountId({
    type: "js",
    version: "2",
    currencyId: currency.id,
    xpubOrAddress: mainAccAddress,
    derivationMode,
  });

  const onChainTokenAccsByMint = pipe(
    () => onChaintokenAccounts,
    groupBy(({ info: { mint } }) => mint.toBase58()),
    (v) => new Map(toPairs(v))
  )();

  const subAccByMint = pipe(
    () => mainInitialAcc?.subAccounts ?? [],
    filter((subAcc): subAcc is TokenAccount => subAcc.type === "TokenAccount"),
    keyBy((subAcc) => toTokenMint(subAcc.token.id)),
    (v) => new Map(toPairs(v))
  )();

  const nextSubAccs2: TokenAccount[] = [];

  for (const [mint, accs] of onChainTokenAccsByMint.entries()) {
    if (!tokenIsListedOnLedger(mint)) {
      continue;
    }

    const assocTokenAccPubkey = await findAssociatedTokenAccountPubkey(
      mainAccAddress,
      mint
    );

    const assocTokenAcc = accs.find(({ onChainAcc: { pubkey } }) =>
      pubkey.equals(assocTokenAccPubkey)
    );

    if (assocTokenAcc === undefined) {
      continue;
    }

    const subAcc = subAccByMint.get(mint);

    const lastSyncedTxSignature = subAcc?.operations?.[0].hash;

    const txs = await getTransactions(
      assocTokenAcc.onChainAcc.pubkey.toBase58(),
      lastSyncedTxSignature
    );

    const nextSubAcc =
      subAcc === undefined
        ? newSubAcc({
            mainAccountId,
            assocTokenAcc,
            txs,
          })
        : patchedSubAcc({
            subAcc,
            assocTokenAcc,
            txs,
          });

    nextSubAccs2.push(nextSubAcc);
  }

  const mainAccountLastTxSignature = mainInitialAcc?.operations[0]?.hash;

  const newMainAccTxs = await getTransactions(
    mainAccAddress,
    mainAccountLastTxSignature
  );

  const newMainAccOps = newMainAccTxs
    .map((tx) => txToMainAccOperation(tx, mainAccountId, mainAccAddress))
    .filter((op): op is Operation => op !== undefined);

  const mainAccTotalOperations = mergeOps(
    mainInitialAcc?.operations ?? [],
    newMainAccOps
  );

  const shape: Partial<Account> = {
    subAccounts: nextSubAccs2,
    id: mainAccountId,
    blockHeight,
    balance: mainAccBalance,
    spendableBalance: mainAccSpendableBalance,
    operations: mainAccTotalOperations,
    operationsCount: mainAccTotalOperations.length,
  };

  return shape;
};

const postSync = (initial: Account, synced: Account) => {
  return synced;
};

function newSubAcc({
  mainAccountId,
  assocTokenAcc,
  txs,
}: {
  mainAccountId: string;
  assocTokenAcc: OnChainTokenAccount;
  txs: TransactionDescriptor[];
}): TokenAccount {
  // TODO: check the order of txs
  const firstTx = txs[txs.length - 1];

  const creationDate = new Date(
    (firstTx.info.blockTime ?? Date.now() / 1000) * 1000
  );

  const tokenId = toTokenId(assocTokenAcc.info.mint.toBase58());
  const tokenCurrency = getTokenById(tokenId);

  const accosTokenAccPubkey = assocTokenAcc.onChainAcc.pubkey;

  const accountId = encodeAccountIdWithTokenAccountAddress(
    mainAccountId,
    accosTokenAccPubkey.toBase58()
  );

  const balance = new BigNumber(assocTokenAcc.info.tokenAmount.amount);

  const newOps = compact(
    txs.map((tx) => txToTokenAccOperation(tx, assocTokenAcc, accountId))
  );

  return {
    balance,
    balanceHistoryCache: emptyHistoryCache,
    creationDate,
    id: accountId,
    parentId: mainAccountId,
    operations: mergeOps([], newOps),
    // TODO: fix
    operationsCount: txs.length,
    pendingOperations: [],
    spendableBalance: balance,
    starred: false,
    swapHistory: [],
    token: tokenCurrency,
    type: "TokenAccount",
  };
}

function patchedSubAcc({
  subAcc,
  assocTokenAcc,
  txs,
}: {
  subAcc: TokenAccount;
  assocTokenAcc: OnChainTokenAccount;
  txs: TransactionDescriptor[];
}): TokenAccount {
  const balance = new BigNumber(assocTokenAcc.info.tokenAmount.amount);

  const newOps = compact(
    txs.map((tx) => txToTokenAccOperation(tx, assocTokenAcc, subAcc.id))
  );

  const totalOps = mergeOps(subAcc.operations, newOps);

  return {
    ...subAcc,
    balance,
    spendableBalance: balance,
    operations: totalOps,
  };
}

function txToMainAccOperation(
  tx: TransactionDescriptor,
  accountId: string,
  accountAddress: string
): Operation | undefined {
  if (!tx.info.blockTime || !tx.parsed.meta) {
    return undefined;
  }

  const { message } = tx.parsed.transaction;

  const accountIndex = message.accountKeys.findIndex(
    (pma) => pma.pubkey.toBase58() === accountAddress
  );

  if (accountIndex < 0) {
    return undefined;
  }

  const { preBalances, postBalances } = tx.parsed.meta;

  const balanceDelta = new BigNumber(postBalances[accountIndex]).minus(
    new BigNumber(preBalances[accountIndex])
  );

  const isFeePayer = accountIndex === 0;
  const txFee = new BigNumber(tx.parsed.meta.fee);

  const opType = getMainAccOperationType({
    tx: tx.parsed.transaction,
    fee: txFee,
    isFeePayer,
    balanceDelta,
  });

  const { senders, recipients } = message.accountKeys.reduce(
    (acc, account, i) => {
      const delta = new BigNumber(postBalances[i]).minus(
        new BigNumber(preBalances[i])
      );
      if (delta.lt(0)) {
        const shouldConsiderAsSender = i > 0 || !delta.negated().eq(txFee);
        if (shouldConsiderAsSender) {
          acc.senders.push(account.pubkey.toBase58());
        }
      } else if (delta.gt(0)) {
        acc.recipients.push(account.pubkey.toBase58());
      }
      return acc;
    },
    {
      senders: [] as string[],
      recipients: [] as string[],
    }
  );

  const txHash = tx.info.signature;
  const txDate = new Date(tx.info.blockTime * 1000);

  /*
  const subOperations = message.instructions.reduce((operations, ix) => {
    const ixDescriptor = parseQuiet(ix, tx.parsed.transaction);
    //ixDescriptor.program === 'stake'
  }, [] as Operation[]);
  */

  const opFee = isFeePayer ? txFee : new BigNumber(0);

  const value = balanceDelta.abs().minus(opFee);
  const opValue = opType === "OPT_OUT" ? value.negated() : value;

  return {
    id: encodeOperationId(accountId, txHash, opType),
    hash: txHash,
    accountId: accountId,
    hasFailed: !!tx.info.err,
    blockHeight: tx.info.slot,
    blockHash: message.recentBlockhash,
    extra: {
      memo: tx.info.memo ?? undefined,
    },
    type: opType,
    senders,
    recipients,
    date: txDate,
    value: opValue,
    fee: opFee,
  };
}

function txToTokenAccOperation(
  tx: TransactionDescriptor,
  assocTokenAcc: OnChainTokenAccount,
  accountId: string
): Operation | undefined {
  if (!tx.info.blockTime || !tx.parsed.meta) {
    return undefined;
  }

  const assocTokenAccIndex =
    tx.parsed.transaction.message.accountKeys.findIndex((v) =>
      v.pubkey.equals(assocTokenAcc.onChainAcc.pubkey)
    );

  if (assocTokenAccIndex < 0) {
    return undefined;
  }

  const { preTokenBalances, postTokenBalances } = tx.parsed.meta;

  const preTokenBalance = preTokenBalances?.find(
    (b) => b.accountIndex === assocTokenAccIndex
  );

  const postTokenBalance = postTokenBalances?.find(
    (b) => b.accountIndex === assocTokenAccIndex
  );

  const delta = new BigNumber(
    postTokenBalance?.uiTokenAmount.amount ?? 0
  ).minus(new BigNumber(preTokenBalance?.uiTokenAmount.amount ?? 0));

  const opType = getTokenAccOperationType({ tx: tx.parsed.transaction, delta });

  const txHash = tx.info.signature;

  const { senders, recipients } = getTokenSendersRecipients({
    meta: tx.parsed.meta,
    accounts: tx.parsed.transaction.message.accountKeys,
  });

  return {
    id: encodeOperationId(accountId, txHash, opType),
    accountId,
    type: opType,
    hash: txHash,
    date: new Date(tx.info.blockTime * 1000),
    blockHeight: tx.info.slot,
    fee: new BigNumber(0),
    recipients,
    senders,
    value: delta.abs(),
    hasFailed: !!tx.info.err,
    extra: {
      memo: tx.info.memo ?? undefined,
    },
    blockHash: tx.parsed.transaction.message.recentBlockhash,
  };
}

/*
function ixDescriptorToPartialOperation(
  ixDescriptor: Exclude<ReturnType<typeof parseQuiet>, undefined>
): Partial<Operation> {
  const { info } = ixDescriptor.instruction ?? {};

  // TODO: fix poor man display
  const infoStrValues =
    info &&
    Object.keys(info).reduce((acc, key) => {
      acc[key] = info[key].toString();
      return acc;
    }, {});

  const extra = {
    program: ixDescriptor.title,
    instruction: ixDescriptor.instruction?.title,
    //info: JSON.stringify(infoStrValues, null, 2),
  };

  return {
    type: "NONE",
    extra,
  };
}
*/

function getMainAccOperationType({
  tx,
  fee,
  isFeePayer,
  balanceDelta,
}: {
  tx: ParsedTransaction;
  fee: BigNumber;
  isFeePayer: boolean;
  balanceDelta: BigNumber;
}): OperationType {
  const type = getMainAccOperationTypeFromTx(tx);

  if (type !== undefined) {
    return type;
  }

  return isFeePayer && balanceDelta.negated().eq(fee)
    ? "FEES"
    : balanceDelta.lt(0)
    ? "OUT"
    : balanceDelta.gt(0)
    ? "IN"
    : "NONE";
}

function getMainAccOperationTypeFromTx(
  tx: ParsedTransaction
): OperationType | undefined {
  const { instructions } = tx.message;
  const [mainIx, ...otherIxs] = instructions
    .map((ix) => parseQuiet(ix, tx))
    .filter(({ program }) => program !== "spl-memo");

  if (mainIx === undefined || otherIxs.length > 0) {
    return undefined;
  }

  switch (mainIx.program) {
    case "spl-associated-token-account":
      switch (mainIx.instruction.type) {
        case "associate":
          return "OPT_IN";
      }
    case "spl-token":
      switch (mainIx.instruction.type) {
        case "closeAccount":
          return "OPT_OUT";
      }
    case "stake":
      switch (mainIx.instruction.type) {
        case "delegate":
          return "DELEGATE";
        case "deactivate":
          return "UNDELEGATE";
      }
    default:
      return undefined;
  }
}

function getTokenSendersRecipients({
  meta,
  accounts,
}: {
  meta: ParsedConfirmedTransactionMeta;
  accounts: ParsedMessageAccount[];
}) {
  const { preTokenBalances, postTokenBalances } = meta;
  return accounts.reduce(
    (accum, account, i) => {
      const preTokenBalance = preTokenBalances?.find(
        (b) => b.accountIndex === i
      );
      const postTokenBalance = postTokenBalances?.find(
        (b) => b.accountIndex === i
      );
      if (preTokenBalance && postTokenBalance) {
        const tokenDelta = new BigNumber(
          postTokenBalance.uiTokenAmount.amount
        ).minus(new BigNumber(preTokenBalance.uiTokenAmount.amount));

        if (tokenDelta.lt(0)) {
          accum.senders.push(account.pubkey.toBase58());
        } else if (tokenDelta.gt(0)) {
          accum.recipients.push(account.pubkey.toBase58());
        }
      }
      return accum;
    },
    {
      senders: [] as string[],
      recipients: [] as string[],
    }
  );
}

function getTokenAccOperationType({
  tx,
  delta,
}: {
  tx: ParsedTransaction;
  delta: BigNumber;
}): OperationType {
  const { instructions } = tx.message;
  const [mainIx, ...otherIxs] = instructions
    .map((ix) => parseQuiet(ix, tx))
    .filter(({ program }) => program !== "spl-memo");

  if (mainIx !== undefined && otherIxs.length === 0) {
    switch (mainIx.program) {
      case "spl-associated-token-account":
        switch (mainIx.instruction.type) {
          case "associate":
            return "OPT_IN";
        }
    }
  }

  const fallbackType = delta.eq(0) ? "NONE" : delta.gt(0) ? "IN" : "OUT";
  return fallbackType;
}

export const sync = makeSync(getAccountShape, postSync);
export const scanAccounts = makeScanAccounts(getAccountShape);
