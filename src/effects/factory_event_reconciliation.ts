import { HypersyncClient } from "@envio-dev/hypersync-client";
import { createEffect, S } from "envio";

const HYPERSYNC_URL = process.env.ENVIO_POLYGON_HYPERSYNC_URL ?? "https://polygon.hypersync.xyz";

export const fetchFactoryEventPage = createEffect(
  {
    name: "fetchFactoryEventPage",
    input: {
      address: S.string,
      topic: S.string,
      fromBlock: S.number,
      toBlock: S.number,
    },
    output: {
      nextBlock: S.number,
      logs: S.array(S.schema({
        address: S.string,
        data: S.string,
        topics: S.array(S.string),
        blockNumber: S.number,
      })),
    },
    rateLimit: { calls: 1, per: "second" as const },
    cache: false,
  },
  async ({ input, context }) => {
    const token = process.env.ENVIO_API_TOKEN;
    if (!token) return { nextBlock: input.fromBlock, logs: [] };
    try {
      const client = new HypersyncClient({ url: HYPERSYNC_URL, apiToken: token });
      const page = await client.get({
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
        logs: [{ address: [input.address], topics: [[input.topic]] }],
        fieldSelection: { log: ["Address", "Data", "Topic0", "Topic1", "Topic2", "Topic3", "BlockNumber"] },
        maxNumLogs: 500,
      });
      return {
        nextBlock: Math.max(input.fromBlock, page.nextBlock),
        logs: page.data.logs.flatMap((log) => {
          if (!log.address || !log.data || !log.blockNumber) return [];
          const topics = log.topics.filter((topic): topic is string => typeof topic === "string");
          return topics.length > 0 ? [{
            address: log.address.toLowerCase(),
            data: log.data,
            topics,
            blockNumber: log.blockNumber,
          }] : [];
        }),
      };
    } catch {
      context.cache = false;
      return { nextBlock: input.fromBlock, logs: [] };
    }
  },
);
