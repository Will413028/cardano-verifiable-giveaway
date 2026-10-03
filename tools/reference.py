"""Independent Python canonicalization and winner-ranking reference; no Node imports."""
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

def main():
    path = ROOT / 'tests/vectors.json'
    if '--check' in sys.argv:
        data = json.loads(path.read_text())
        assert len(data) == 10
        for item in data:
            assert vector(item['bundle']) == item
        print('Independent Python reference: 10 vectors passed')
        return
    labels = [['alice', 'bob', 'carol'], ['甲', '乙', '丙'], ['é', 'Å', 'ü'], ['🎉', '🦉', '🐈'], ['Alice, A', 'Bo"b', 'Carol'],
              ['a', 'A', 'á'], ['one'], ['hello world', 'with/slash', 'with\\slash'], ['日本語', '한국어', '中文'], ['z', 'y', 'x', 'w']]
    result = []
    for i, entrants in enumerate(labels):
        b = dict(version='development-1', algorithm='sha256-ranking-1', drawId=f'vector-{i}', entrants=entrants,
                 rules=dict(winners=min(2, len(entrants))), drand=dict(chainHash='52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', round=1000000))
        result.append(vector(b))
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')

if __name__ == '__main__':
    main()
