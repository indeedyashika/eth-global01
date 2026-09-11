import { BigInt, Address } from "@graphprotocol/graph-ts";
import { Transfer as TransferEvent, ERC20 } from "../generated/ERC20Token/ERC20";
import { Token, Account, Transfer } from "../generated/schema";

function getOrCreateToken(address: Address): Token {
  let token = Token.load(address.toHexString());
  if (token == null) {
    token = new Token(address.toHexString());
    let contract = ERC20.bind(address);

    let nameResult = contract.try_name();
    token.name = nameResult.reverted ? null : nameResult.value;

    let symbolResult = contract.try_symbol();
    token.symbol = symbolResult.reverted ? null : symbolResult.value;

    let decimalsResult = contract.try_decimals();
    token.decimals = decimalsResult.reverted ? 0 : (decimalsResult.value as i32);

    token.transferCount = BigInt.fromI32(0);
    token.save();
  }
  return token as Token;
}

function getOrCreateAccount(tokenAddress: Address, accountAddress: Address): Account {
  let id = tokenAddress.toHexString() + "-" + accountAddress.toHexString();
  let account = Account.load(id);
  if (account == null) {
    account = new Account(id);
    account.token = tokenAddress.toHexString();
    account.address = accountAddress;
    account.balance = BigInt.fromI32(0);
    account.sentCount = BigInt.fromI32(0);
    account.receivedCount = BigInt.fromI32(0);
    account.save();
  }
  return account as Account;
}

// Shared by every dataSource in subgraph.yaml -- event.address tells us which
// contract fired, so the same handler works for any number of tracked tokens.
export function handleTransfer(event: TransferEvent): void {
  let token = getOrCreateToken(event.address);
  token.transferCount = token.transferCount.plus(BigInt.fromI32(1));
  token.save();

  let from = getOrCreateAccount(event.address, event.params.from);
  let to = getOrCreateAccount(event.address, event.params.to);

  let isMint = event.params.from.equals(Address.zero());
  let isBurn = event.params.to.equals(Address.zero());

  if (!isMint) {
    from.balance = from.balance.minus(event.params.value);
    from.sentCount = from.sentCount.plus(BigInt.fromI32(1));
    from.save();
  }
  if (!isBurn) {
    to.balance = to.balance.plus(event.params.value);
    to.receivedCount = to.receivedCount.plus(BigInt.fromI32(1));
    to.save();
  }

  let transfer = new Transfer(
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString()
  );
  transfer.token = token.id;
  transfer.from = from.id;
  transfer.to = to.id;
  transfer.value = event.params.value;
  transfer.isMintOrBurn = isMint || isBurn;
  transfer.blockNumber = event.block.number;
  transfer.blockTimestamp = event.block.timestamp;
  transfer.transactionHash = event.transaction.hash;
  transfer.save();
}
