import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContractFunctionZeroDataError } from 'viem';
import {
  fetchTokenMetaHandler,
  lookupRegistryDecimalsBatch,
  resetTokenMetadataCachesForTest,
} from './token_metadata';

const multicallMock = vi.fn();

vi.mock('./rpc_client', async () => {
  const actual = await vi.importActual<typeof import('./rpc_client')>('./rpc_client');
  return {
    ...actual,
    publicClient: {
      readContract: vi.fn(),
      multicall: (...args: unknown[]) => multicallMock(...args),
    },
  };
});

// Mock bun:sqlite — must be a constructable class (vitest + dynamic import)
vi.mock("bun:sqlite", () => {
  class MockDatabase {
    prepare(_sql: string) {
      return {
        all: () => [{ address: "0xabcdef1234567890abcdef1234567890abcdef12", decimals: 18 }],
      };
    }
  }
  return { Database: MockDatabase };
});

// Mock fs/promises
const readFileMock = vi.fn().mockRejectedValue(new Error('File not found'));
const appendFileMock = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: (...args: unknown[]) => appendFileMock(...args),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

describe('fetchTokenMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTokenMetadataCachesForTest();
    readFileMock.mockRejectedValue(new Error('File not found'));
  });

  it('should return from SQLite registry cache without hitting RPC', async () => {
    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true };
    const input = { address: '0xabcdef1234567890abcdef1234567890abcdef12' };

    const result = await fetchTokenMetaHandler({ input, context });
    expect(result).toEqual({
      address: '0xabcdef1234567890abcdef1234567890abcdef12',
      decimals: 18,
      trusted: true,
    });
    expect(multicallMock).not.toHaveBeenCalled();
  });

  it('should return from in-memory cache on second call', async () => {
    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true };
    const input = { address: '0xabcdef1234567890abcdef1234567890abcdef12' };

    await fetchTokenMetaHandler({ input, context });
    await fetchTokenMetaHandler({ input, context });

    expect(multicallMock).not.toHaveBeenCalled();
  });

  it('should load discovered-decimals.ndjson into cache without RPC', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (String(filePath).includes('discovered-decimals.ndjson')) {
        return '{"address":"0x1234567890123456789012345678901234567890","decimals":6}\n';
      }
      throw new Error('File not found');
    });

    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true };
    const input = { address: '0x1234567890123456789012345678901234567890' };

    const result = await fetchTokenMetaHandler({ input, context });
    expect(result.decimals).toBe(6);
    expect(result.trusted).toBe(true);
    expect(multicallMock).not.toHaveBeenCalled();
  });

  it('batches concurrent cold-token lookups into one multicall', async () => {
    multicallMock.mockResolvedValue([
      { status: 'success', result: 6n },
      { status: 'success', result: 8n },
    ]);

    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true, isPreload: false };
    const addr0 = '0x1111111111111111111111111111111111111111';
    const addr1 = '0x2222222222222222222222222222222222222222';

    const [r0, r1] = await Promise.all([
      fetchTokenMetaHandler({ input: { address: addr0 }, context }),
      fetchTokenMetaHandler({ input: { address: addr1 }, context }),
    ]);

    expect(multicallMock).toHaveBeenCalledTimes(1);
    expect(multicallMock.mock.calls[0]?.[0]?.contracts).toHaveLength(2);
    expect(r0).toEqual({ address: addr0, decimals: 6, trusted: true });
    expect(r1).toEqual({ address: addr1, decimals: 8, trusted: true });
  });

  it('should NOT permanently blocklist a token on a transient network error', async () => {
    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true, isPreload: false };
    const input = { address: '0x1111111111111111111111111111111111111111' };

    multicallMock.mockRejectedValue(new Error('HTTP request failed. Status code: 503'));

    const first = await fetchTokenMetaHandler({ input, context });
    expect(first).toEqual({ address: input.address, decimals: 18, trusted: false });
    expect(context.cache).toBe(false);

    await fetchTokenMetaHandler({ input, context });
    expect(multicallMock).toHaveBeenCalledTimes(2);
  });

  it('should permanently blocklist a token on a definitive zero-data error', async () => {
    const context = { log: { info: vi.fn(), warn: vi.fn() }, cache: true, isPreload: false };
    const input = { address: '0x2222222222222222222222222222222222222222' };

    multicallMock.mockResolvedValue([
      { status: 'failure', error: new ContractFunctionZeroDataError({ functionName: 'decimals' }) },
    ]);

    const first = await fetchTokenMetaHandler({ input, context });
    expect(first).toEqual({ address: input.address, decimals: 18, trusted: false });

    await fetchTokenMetaHandler({ input, context });
    expect(multicallMock).toHaveBeenCalledTimes(1);
  });

  it('lookupRegistryDecimalsBatch resolves multiple tokens from discovered ndjson without RPC', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      if (String(filePath).includes('discovered-decimals.ndjson')) {
        return [
          '{"address":"0x1234567890123456789012345678901234567890","decimals":6}',
          '{"address":"0xabcdefabcdefabcdefabcdefabcdefabcdefabcd","decimals":9}',
        ].join('\n') + '\n';
      }
      throw new Error('File not found');
    });

    const hits = await lookupRegistryDecimalsBatch([
      '0x1234567890123456789012345678901234567890',
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      '0x0000000000000000000000000000000000000001',
    ]);

    expect(hits.get('0x1234567890123456789012345678901234567890')).toEqual({ decimals: 6, trusted: true });
    expect(hits.get('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')).toEqual({ decimals: 9, trusted: true });
    expect(hits.has('0x0000000000000000000000000000000000000001')).toBe(false);
    expect(multicallMock).not.toHaveBeenCalled();
  });
});
