import {
  Chain,
  Network,
  TokenId,
  TokenTransfer,
  Wormhole,
  amount,
  isTokenId,
  wormhole,
} from "@wormhole-foundation/sdk";

import { getStuff, waitLog, TransferStuff } from "./helpers";

import evm from "@wormhole-foundation/sdk/evm";
import solana from "@wormhole-foundation/sdk/solana";
import { ethers } from "ethers";

async function main() {
  const wh = await wormhole("Mainnet", [evm, solana]);

  const sendChain = wh.getChain("Solana");
  const rcvChain = wh.getChain("Base");

  // shortcut to allow transferring native gas token
  const token = Wormhole.tokenId(sendChain.chain, "native");
  const amt = "0.001";
  const automatic = true;
  const nativeGas = automatic ? "0.00001" : undefined;

  const source = await getStuff(sendChain);
  const destination = await getStuff(rcvChain);

  const decimals = isTokenId(token)
    ? await wh.getDecimals(token.chain, token.address)
    : sendChain.config.nativeTokenDecimals;

  let recoverTxid = undefined;

  const xfer = !recoverTxid
    ? // Perform the token transfer
      await tokenTransfer(wh, {
        token,
        amount: amount.parse(amt, decimals),
        source,
        destination,
        delivery: {
          automatic,
          nativeGas: nativeGas ? amount.parse(nativeGas, decimals) : undefined,
        },
      })
    : // Recover the transfer from the originating txid
      await TokenTransfer.from(wh, {
        chain: source.chain.chain,
        txid: recoverTxid,
      });

  const receipt = await waitLog(wh, xfer);

  console.log("Receipt", receipt);
}

main().catch(console.error);

async function tokenTransfer<N extends Network>(
  wh: Wormhole<N>,
  route: {
    token: TokenId;
    amount: amount.Amount;
    source: TransferStuff<N, Chain>;
    destination: TransferStuff<N, Chain>;
    delivery?: {
      automatic: boolean;
      nativeGas?: amount.Amount;
    };
    payload?: Uint8Array;
  },
  roundTrip?: boolean
): Promise<TokenTransfer<N>> {
  // Create a TokenTransfer object to track the state of
  // the transfer over time
  const xfer = await wh.tokenTransfer(
    route.token,
    amount.units(route.amount),
    route.source.address,
    route.destination.address,
    route.delivery?.automatic ?? false,
    route.payload,
    route.delivery?.nativeGas
      ? amount.units(route.delivery?.nativeGas)
      : undefined
  );

  const quote = await TokenTransfer.quoteTransfer(
    wh,
    route.source.chain,
    route.destination.chain,
    xfer.transfer
  );
  console.log(quote);

  if (xfer.transfer.automatic && quote.destinationToken.amount < 0)
    throw "The amount requested is too low to cover the fee and any native gas requested.";

  // 1) Submit the transactions to the source chain, passing a signer to sign any txns
  console.log("Starting transfer");
  const srcTxids = await xfer.initiateTransfer(route.source.signer);
  console.log(`Started transfer: `, srcTxids);

  // If automatic, we're done
  if (route.delivery?.automatic) return xfer;

  // 2) wait for the VAA to be signed and ready (not required for auto transfer)
  console.log("Getting Attestation");
  const attestIds = await xfer.fetchAttestation(60_000);
  console.log(`Got Attestation: `, attestIds);

  // 3) redeem the VAA on the dest chain
  console.log("Completing Transfer");
  const destTxids = await xfer.completeTransfer(route.destination.signer);
  console.log(`Completed Transfer: `, destTxids);

  // No need to send back, dip
  if (!roundTrip) return xfer;

  const { destinationToken: token } = quote;
  return await tokenTransfer(wh, {
    ...route,
    token: token.token,
    amount: amount.parse(token.amount.toString(), route.amount.decimals),
    source: route.destination,
    destination: route.source,
  });
}
