"""Independent Python cryptography/Web Crypto checks using synthetic test data."""
import base64,json,os,subprocess
from pathlib import Path
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
root=Path(__file__).resolve().parent.parent
password='synthetic orchard river violet 23'
message='Independent interoperability test — 第二行 🛡️\nSynthetic data only.'
aad=b'VVAULT:1:PBKDF2-SHA256:600000:AES-256-GCM'
def node(source,data):
    result=subprocess.run(['node','--input-type=module','-e',source],input=json.dumps(data),text=True,capture_output=True,cwd=root,check=True)
    return json.loads(result.stdout)
envelope=node("import {encryptMessage} from './apps/vault/crypto.js';let text='';for await(const chunk of process.stdin)text+=chunk;const d=JSON.parse(text);console.log(JSON.stringify(await encryptMessage(d.message,d.password)));",{'message':message,'password':password})
obj=json.loads(envelope)
salt=base64.b64decode(obj['salt'],validate=True)
key=PBKDF2HMAC(algorithm=hashes.SHA256(),length=32,salt=salt,iterations=600000).derive(password.encode())
assert AESGCM(key).decrypt(base64.b64decode(obj['iv']),base64.b64decode(obj['ciphertext']),aad).decode()==message
salt,iv=os.urandom(16),os.urandom(12)
key=PBKDF2HMAC(algorithm=hashes.SHA256(),length=32,salt=salt,iterations=600000).derive(password.encode())
obj.update(salt=base64.b64encode(salt).decode(),iv=base64.b64encode(iv).decode(),ciphertext=base64.b64encode(AESGCM(key).encrypt(iv,message.encode(),aad)).decode())
plain=node("import {decryptMessage} from './apps/vault/crypto.js';let text='';for await(const chunk of process.stdin)text+=chunk;const d=JSON.parse(text);console.log(JSON.stringify(await decryptMessage(d.envelope,d.password)));",{'envelope':json.dumps(obj,separators=(',',':')),'password':password})
assert plain==message
print('PASS: Web Crypto → independent Python AES-GCM/PBKDF2 and Python → Web Crypto; synthetic Unicode message preserved.')
