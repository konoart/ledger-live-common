import { Account } from "../../../types";
import { Transaction, TransactionModel } from "../types";
import { assertUnreachable, clusterByCurrencyId } from "../utils";
import { getPrepareTxAPIQueued } from "./prepare-tx-api-queued";
import { getPrepareTxAPICached, minutes } from "./prepare-tx-api-cached";
import { prepareTransaction as prepareTransactionWithAPI } from "../js-prepareTransaction";
import { makeLRUCache } from "../../../cache";
import { getPrepareTxAPI } from "./prepare-tx-api";
import { Config } from "../api";
import { ChainAPI } from "../api/web4";

const cacheKeyCluster = (config: Config) => config.cluster;

const prepareTxQueuedAndCachedAPI = makeLRUCache(
  (config: Config) => {
    const api = getPrepareTxAPI(config);
    const queuedApi = getPrepareTxAPIQueued(api);
    const queuedAndCachedApi = getPrepareTxAPICached(queuedApi);
    return Promise.resolve(queuedAndCachedApi);
  },
  cacheKeyCluster,
  minutes(1000)
);

const cacheKeyByModelUIState = (model: TransactionModel) => {
  switch (model.kind) {
    case "transfer":
      return `{
        memo: ${model.uiState.memo}
      }`;
    case "token.transfer":
      return `{
        memo: ${model.uiState.memo},
        subAccountId: ${model.uiState.subAccountId}
      }`;
    case "token.createATA":
      return `{
        tokenId: ${model.uiState.tokenId}
      }`;
    default:
      return assertUnreachable(model);
  }
};

export const cacheKeyByAccTx = (mainAccount: Account, tx: Transaction) => {
  // json stringify is not stable, using a stable one from a library is probably an overkill
  return `{
    account: {
      id: ${mainAccount.id},
      address: ${mainAccount.freshAddress},
      syncDate: ${mainAccount.lastSyncDate.toISOString()},
    },
    tx: {
      recipient: ${tx.recipient},
      amount: ${tx.amount.toNumber()},
      useAllAmount: ${tx.useAllAmount},
      subAccountId: ${tx.subAccountId},
      model: {
        kind: ${tx.model.kind},
        uiState: ${cacheKeyByModelUIState(tx.model)},
      },
    },
  }`;
};

/*
const prepareTransactionWithAPICached = makeLRUCache(
  prepareTransactionWithAPI,
  cacheKeyByAccTxCluster,
  minutes(1)
);
*/

//export { prepareTransactionWithAPICached };
