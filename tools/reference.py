"""Independent Python canonicalization, winner-ranking and transaction-hash reference; no Node imports."""
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RANDOMNESS = 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3'

def canonical(value):
    if isinstance(value, dict):
        return '{' + ','.join(canonical(k) + ':' + canonical(value[k]) for k in sorted(value, key=lambda x: x.encode('utf-16-be'))) + '}'
    if isinstance(value, list):
        return '[' + ','.join(canonical(x) for x in value) + ']'
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

def vector(bundle):
    encoded = canonical(bundle)
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    seed = hashlib.sha256(bytes.fromhex(RANDOMNESS + digest)).digest()
    winners = sorted(enumerate(bundle['entrants']), key=lambda pair: (hashlib.sha256(seed + pair[1].encode()).hexdigest(), pair[0]))
    return dict(bundle=bundle, canonical=encoded, hash=digest, randomness=RANDOMNESS, winners=[label for _, label in winners[:bundle['rules']['winners']]])

def cbor_item(data, pos):
    """Return (start of content, end) of the CBOR item at pos, walking nested items without decoding values."""
    initial = data[pos]
    major, info = initial >> 5, initial & 31
    pos += 1
    if info < 24:
        arg = info
    elif info in (24, 25, 26, 27):
        size = 1 << (info - 24)
        arg = int.from_bytes(data[pos:pos + size], 'big')
        pos += size
    elif info == 31 and major in (2, 3, 4, 5):
        arg = None
    else:
        raise ValueError('unsupported CBOR head')
    start = pos
    if major in (0, 1, 7):
        return start, pos
    if major in (2, 3):
        if arg is None:
            while data[pos] != 0xff:
                pos = cbor_item(data, pos)[1]
            return start, pos + 1
        return start, pos + arg
    if major == 6:
        return start, cbor_item(data, pos)[1]
    count = (arg if arg is not None else float('inf')) * (2 if major == 5 else 1)
    n = 0
    while n < count and not (arg is None and data[pos] == 0xff):
        pos = cbor_item(data, pos)[1]
        n += 1
    return start, pos + (1 if arg is None else 0)

def transaction_hashes(cbor_hex):
    """blake2b-256 over the raw body bytes and over the raw auxiliary data bytes (last element, None when null)."""
    data = bytes.fromhex(cbor_hex)
    start, end = cbor_item(data, 0)
    assert end == len(data) and data[0] in (0x83, 0x84), 'not a transaction'
    elements = []
    pos = start
    while pos < end:
        item_end = cbor_item(data, pos)[1]
        elements.append(data[pos:item_end])
        pos = item_end
    body, aux = elements[0], elements[-1]
    blake = lambda b: hashlib.blake2b(b, digest_size=32).hexdigest()
    return blake(body), None if aux == b'\xf6' else blake(aux)

def check_transactions():
    data = json.loads((ROOT / 'tests/transactions.json').read_text())
    for item in data:
        assert transaction_hashes(item['cbor']) == (item['txHash'], item['auxiliaryDataHash']), item['name']
        # One byte of the first input's transaction id (the first 32-byte string in the body) must move the hash.
        changed = bytearray.fromhex(item['cbor'])
        changed[changed.index(b'\x58\x20') + 33] ^= 1
        assert transaction_hashes(changed.hex())[0] != item['txHash'], item['name']
    return len(data)

def main():
    path = ROOT / 'tests/vectors.json'
    if '--check' in sys.argv:
        data = json.loads(path.read_text())
        assert len(data) == 10
        for item in data:
            assert vector(item['bundle']) == item
        print('Independent Python reference: 10 vectors passed')
        print(f'Independent Python reference: {check_transactions()} transaction and auxiliary data hashes passed')
        return
    labels = [['alice', 'bob', 'carol'], ['甲', '乙', '丙'], ['é', 'Å', 'ü'], ['🎉', '🦉', '🐈'], ['Alice, A', 'Bo"b', 'Carol'],
              ['a', 'A', 'á'], ['one'], ['hello world', 'with/slash', 'with\\slash'], ['日本語', '한국어', '中文'], ['z', 'y', 'x', 'w']]
    result = []
    for i, entrants in enumerate(labels):
        b = dict(version='development-2', algorithm='sha256-ranking-1', drawId=f'vector-{i}', entrants=entrants,
                 rules=dict(winners=min(2, len(entrants))), drand=dict(chainHash='52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', round=1000000))
        result.append(vector(b))
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')

if __name__ == '__main__':
    main()
