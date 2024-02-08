import { ethers } from "ethers";
import { NextRequest, NextResponse } from "next/server";
import { Packet } from "utils/types";
import { CHAIN, CHAIN_CONFIGS } from "utils/chains/chains";
import Abi from "utils/contracts/dispatcher.json";
import CachingJsonRpcProvider from "../utils/cache";
import { getTmClient } from "../utils/tendermint";
import { GET as getChannels } from "../channels/route";

export const dynamic = 'force-dynamic' // defaults to auto

export async function GET(request: NextRequest) {
  const apiUrl = process.env.API_URL!
  const searchParams = request.nextUrl.searchParams
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const chainFrom = searchParams.get('chainFrom')
  const chainTo = searchParams.get('chainTo')
  const dispatcher = searchParams.get('dispatcher')

  if (!from || !chainFrom || !chainTo) {
    return NextResponse.error()
  }

  const channels = await getChannels()
  const openChannels = channels.filter((channel) => {
    return channel.state.toString() === "STATE_OPEN"
      // && (
      //   (channel.portId.startsWith(`polyibc.${chainFrom}.`) && channel.counterparty.portId.startsWith(`polyibc.${chainTo}.`))
      //   || (channel.portId.startsWith(`polyibc.${chainTo}.`) && channel.counterparty.portId.startsWith(`polyibc.${chainFrom}.`))
      // )
  })
  if (openChannels.length === 0) {
    return NextResponse.json([]);
  }

  const tmClient = await getTmClient(apiUrl)

  const validChannelIds = new Set<string>()
  openChannels.forEach((channel) => {
    validChannelIds.add(channel.channelId)
  })

  const fromBlock = Number(from)
  const toBlock = to ? Number(to) : "latest"

  const chainFromId = chainFrom as CHAIN
  const dispatcherFromAddress = dispatcher ?? CHAIN_CONFIGS[chainFromId].dispatcher;
  const providerFrom = new CachingJsonRpcProvider(CHAIN_CONFIGS[chainFromId].rpc, CHAIN_CONFIGS[chainFromId].id);
  const contractFrom = new ethers.Contract(dispatcherFromAddress, Abi.abi, providerFrom);

  const sendPacketLogs = (await contractFrom.queryFilter('SendPacket', fromBlock, toBlock)) as Array<ethers.EventLog>;

  const unprocessedPacketKeys = new Set<string>();

  const packets: Record<string, Packet> = {};
  for (const sendPacketLog of sendPacketLogs) {
    let [sourcePortAddress, sourceChannelId, packet, sequence, timeout, fee] = sendPacketLog.args;
    sourceChannelId = ethers.decodeBytes32String(sourceChannelId)

    // Only collect packets for open channels
    if (!validChannelIds.has(sourceChannelId)) {
      console.log("Skipping packet for channel: ", sourceChannelId)
      continue
    }

    // Find channel this packet is sent over
    const channel = openChannels.find((channel) => {
      return channel.channelId === sourceChannelId // && channel.portId === `polyibc.${chainFrom}.${sourcePortAddress.slice(2)}`
    })
    if (!channel) {
      console.warn("No channel found for packet: ", sourceChannelId, sourcePortAddress)
      continue
    }

    const key = `${sourcePortAddress}-${sourceChannelId}-${sequence}`;
    const blockFrom = await providerFrom.getBlock(sendPacketLog.blockNumber)

    packets[key] = {
      sourcePortAddress,
      sourceChannelId: sourceChannelId,
      destPortAddress: channel.counterparty.portId,
      destChannelId: channel.counterparty.channelId,
      fee,
      sequence: sequence.toString(),
      timeout: timeout.toString(),
      id: key,
      state: "SENT",
      createTime: blockFrom!.timestamp,
      sendTx: sendPacketLog.transactionHash,
      sourceChain: channel.portId.split(".")[1] as CHAIN,
      destChain: channel.counterparty.portId.split(".")[1] as CHAIN,
    };
    unprocessedPacketKeys.add(key);
  }

  // States could be like:
  // SENT (event on L2), POLY_RECV (received by Polymer), POLY_SENT (committed on Polymer), RECV (event on L2),
  // WRITE_ACK (event on L2), POLY_ACK_RECV (ack received on Polymer), POLY_WRITE_ACK (ack written on Polymer), ACK (event on L2)

  // To set a proper state for each packet, start with SENT state for all relevant packets, then:
  // For each packet go into the reverse direction of the packet flow starting from ACK
  // If a packet reached the corresponding state, set it as the state for the packet and move on to the next packet
  // Otherwise move to the next state until SENT state is reached

  const chainToId = chainTo as CHAIN
  const dispatcherToAddress = CHAIN_CONFIGS[chainToId].dispatcher;
  const providerTo = new CachingJsonRpcProvider(CHAIN_CONFIGS[chainToId].rpc, CHAIN_CONFIGS[chainToId].id);
  const contractTo = new ethers.Contract(dispatcherToAddress, Abi.abi, providerTo);

  const ackLogs = (await contractFrom.queryFilter('Acknowledgement', fromBlock, toBlock)) as Array<ethers.EventLog>;
  console.log("Ack logs: ", ackLogs.length)

  for (const ackLog of ackLogs) {
    let [sourcePortAddress, sourceChannelId, sequence] = ackLog.args;
    const key = `${sourcePortAddress}-${ethers.decodeBytes32String(sourceChannelId)}-${sequence}`;
    if (packets[key]) {
      const blockFrom = await providerFrom.getBlock(ackLog.blockNumber)
      if (blockFrom!.timestamp < packets[key].createTime) {
        continue
      }

      packets[key].endTime = blockFrom!.timestamp;
      packets[key].state = "ACK";
      packets[key].ackTx = ackLog.transactionHash;
      unprocessedPacketKeys.delete(key);
    } else {
      console.log("No packet found for ack: ", key)
    }
  }

  for (const key of unprocessedPacketKeys) {
    const packet = packets[key]

    try {
      const ack = await tmClient.ibc.channel.packetAcknowledgement(packet.destPortAddress, packet.destChannelId, Number(packet.sequence))
      console.log("Ack: ", ack)
      if (ack.acknowledgement) {
        packet.state = "POLY_WRITE_ACK";
        unprocessedPacketKeys.delete(key);
      }
    } catch (e) {
      // api call throws an error if no ack is found
      return NextResponse.error();
    }
  }

  // It seems that due to short circuiting POLY_ACK_RECV can be distinguished as a separate state so this state is skipped

  // TODO: use a more narrow from and to block for dest chain
  const writeAckLogs = (await contractTo.queryFilter('WriteAckPacket', 1, "latest")) as Array<ethers.EventLog>;
  for (const writeAckLog of writeAckLogs) {
    const [receiver, destChannelId, sequence, ack] = writeAckLog.args;

    const channel = openChannels.find((channel) => {
      return channel.counterparty.channelId === ethers.decodeBytes32String(destChannelId) && channel.counterparty.portId === `polyibc.${chainTo}.${receiver.slice(2)}`
    })

    if (!channel) {
      console.log("Unable to find channel for write ack: ", destChannelId, "receiver: ", receiver)
      continue
    }

    const key = `${channel.portId}-${channel.channelId}-${sequence}`;
    if (key in unprocessedPacketKeys) {
      packets[key].state = "WRITE_ACK";
      unprocessedPacketKeys.delete(key);
    }
  }

  // TODO: use a more narrow from and to block for dest chain
  const recvPacketLogs = (await contractTo.queryFilter('RecvPacket', 1, "latest")) as Array<ethers.EventLog>;

  for (const recvPacketLog of recvPacketLogs) {
    const [destPortAddress, destChannelId, sequence] = recvPacketLog.args;

    const channel = openChannels.find((channel) => {
      return channel.counterparty.channelId === ethers.decodeBytes32String(destChannelId) && channel.counterparty.portId === `polyibc.${chainTo}.${destPortAddress.slice(2)}`
    })

    if (!channel) {
      console.log("Unable to find channel for recv packet: ", destChannelId, "receiver: ", destPortAddress)
      continue
    }


    const key = `0x${channel.portId.split(".")[2]}-${channel.channelId}-${sequence}`;
    const recvBlock = await providerTo.getBlock(recvPacketLog.blockNumber)

    if (recvBlock!.timestamp < packets[key].createTime) {
      continue
    }

    if (key in unprocessedPacketKeys) {
      packets[key].state = "RECV";
      unprocessedPacketKeys.delete(key);
    }


    if (packets[key]) {
      packets[key].rcvTx = recvPacketLog.transactionHash;
    }
  }

  for (const key of unprocessedPacketKeys) {
    const packet = packets[key]

    try {
      const packetCommitment = await tmClient.ibc.channel.packetCommitment(packet.sourcePortAddress, packet.sourceChannelId, Number(packet.sequence))
      console.log("Packet commitment: ", packetCommitment)
      if (packetCommitment.commitment) {
        packet.state = "POLY_WRITE_ACK";
        unprocessedPacketKeys.delete(key);
      }
    } catch (e) {
      // api call throws an error if no commitment is found
    }
  }

  for (const key of unprocessedPacketKeys) {
    const packet = packets[key]

    const packetReceipt = await tmClient.ibc.channel.packetReceipt(packet.destPortAddress, packet.destChannelId, Number(packet.sequence))
    if (packetReceipt.received) {
      packet.state = "POLY_RECV";
      unprocessedPacketKeys.delete(key);
    }
  }

  const response: Packet[] = [];
  Object.keys(packets).forEach((key) => {
    response.push(packets[key]);
  });
  return NextResponse.json(response);
}