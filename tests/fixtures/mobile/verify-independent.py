"""Independent crypto check of public fictional fixtures; not a security audit."""
import base64
import json
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

root = Path(__file__).resolve().parent
info = json.loads((root / 'expected.json').read_text(encoding='utf-8'))
aad = b'VVAULT:1:PBKDF2-SHA256:600000:AES-256-GCM'


def decrypt(name, phrase):
    envelope = json.loads((root / name).read_text(encoding='utf-8'))
    assert envelope['format'] == 'VVAULT' and envelope['version'] == 1
    assert envelope['kdf'] == 'PBKDF2-SHA256' and envelope['iterations'] == 600000
    assert envelope['cipher'] == 'AES-256-GCM'
    decode = lambda field: base64.b64decode(envelope[field], validate=True)
    salt, iv, ciphertext = decode('salt'), decode('iv'), decode('ciphertext')
    assert len(salt) == 16 and len(iv) == 12
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=600000).derive(phrase.encode('utf-8'))
    return AESGCM(key).decrypt(iv, ciphertext, aad)


expected = info['plaintext'].encode('utf-8')
assert base64.b64encode(expected).decode('ascii') == info['plaintext_utf8_base64']
assert decrypt('valid.vvault.json', info['passphrase']) == expected
for name, phrase in [('valid.vvault.json', info['wrong_passphrase']),
                     ('tampered-ciphertext.vvault.json', info['passphrase'])]:
    try:
        decrypt(name, phrase)
    except InvalidTag:
        continue
    raise AssertionError('Expected authenticated-decryption rejection: ' + name)
print('PASS: independent Python AES-GCM/PBKDF2 exact plaintext and InvalidTag checks. No device tests performed.')
