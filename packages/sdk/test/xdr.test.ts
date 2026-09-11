import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  SplitStreamError,
  addressToScVal,
  bytesToScVal,
  findContractErrorCode,
  i128ToScVal,
  isVoidScVal,
  proofToScVal,
  scValToBigInt,
  scValToBool,
  scValToHexOrNull,
  scValToNativeValue,
  u32ToScVal,
} from '../src/index.js';
import { ADDRESS_A } from './fixtures.js';

function diagnosticWith(data: xdr.ScVal): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: null,
      type: xdr.ContractEventType.system,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [], data })),
    }),
  });
}

describe('address and integer encoding', () => {
  it('round-trips an address', () => {
    expect(scValToNativeValue(addressToScVal(ADDRESS_A))).toBe(ADDRESS_A);
  });

  it('encodes i128 values exactly, including values above 2^53', () => {
    const amount = 123_456_789_012_345_678_901_234_567n;
    const encoded = i128ToScVal(amount);
    expect(encoded.type).toBe('scvI128');
    expect(scValToBigInt(encoded, 'test')).toBe(amount);
  });

  it('rejects a non-u32 cycle id', () => {
    expect(() => u32ToScVal(-1)).toThrow(SplitStreamError);
    expect(() => u32ToScVal(1.5)).toThrow(SplitStreamError);
    expect(() => u32ToScVal(2 ** 33)).toThrow(SplitStreamError);
  });

  it('decodes booleans and rejects mismatched types', () => {
    expect(scValToBool(nativeToScVal(true, { type: 'bool' }), 'test')).toBe(true);
    expect(() => scValToBool(nativeToScVal(1n, { type: 'i128' }), 'test')).toThrow(SplitStreamError);
  });
});

describe('proofToScVal', () => {
  it('encodes each sibling as a 32-byte element', () => {
    const scval = proofToScVal(['aa'.repeat(32), 'bb'.repeat(32)]);
    if (scval.type !== 'scvVec') throw new Error('expected the proof to encode as a vector');
    expect(scval.vec).toHaveLength(2);
    expect(scval.vec?.[0]?.type).toBe('scvBytes');
    expect(scval.vec?.[1]?.type).toBe('scvBytes');
  });

  it('rejects a proof element that is not 32 bytes', () => {
    expect(() => proofToScVal(['aa'.repeat(16)])).toThrow(/must be 32 bytes/);
  });

  it('rejects a proof element that is not hex', () => {
    expect(() => proofToScVal(['zz'.repeat(32)])).toThrow(/non-hex/);
  });
});

describe('scValToHexOrNull', () => {
  it('returns null for void', () => {
    expect(isVoidScVal(xdr.ScVal.scvVoid())).toBe(true);
    expect(scValToHexOrNull(xdr.ScVal.scvVoid(), 'root')).toBeNull();
  });

  it('hex-encodes a byte root', () => {
    const bytes = new Uint8Array(32).fill(0xab);
    expect(scValToHexOrNull(bytesToScVal(bytes), 'root')).toBe('ab'.repeat(32));
  });

  it('passes through an already-hex string root', () => {
    expect(scValToHexOrNull(nativeToScVal('cd'.repeat(32), { type: 'string' }), 'root')).toBe(
      'cd'.repeat(32),
    );
  });
});

describe('findContractErrorCode', () => {
  it('returns null when there are no events', () => {
    expect(findContractErrorCode(undefined)).toBeNull();
    expect(findContractErrorCode([])).toBeNull();
  });

  it('extracts a contract error from diagnostic event data', () => {
    const events = [diagnosticWith(xdr.ScVal.scvError(xdr.ScError.sceContract(9)))];
    expect(findContractErrorCode(events)).toBe(9);
  });

  it('extracts a contract error nested inside a vector', () => {
    const events = [
      diagnosticWith(
        xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvError(xdr.ScError.sceContract(15))]),
      ),
    ];
    expect(findContractErrorCode(events)).toBe(15);
  });

  it('ignores non-contract host errors', () => {
    const events = [
      diagnosticWith(xdr.ScVal.scvError(xdr.ScError.sceBudget(xdr.ScErrorCode.scecExceededLimit))),
    ];
    expect(findContractErrorCode(events)).toBeNull();
  });
});
