# SPDX-License-Identifier: GPL-3.0-or-later
from pathlib import Path
import zipfile
root=Path(__file__).resolve().parent.parent
def write(archive,files):
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for source,name in sorted(files,key=lambda pair:pair[1]):
            info=zipfile.ZipInfo(name,date_time=(2026,10,23,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=(0o755 if source.suffix=='.sh' else 0o644)<<16
            z.writestr(info,source.read_bytes())
files=[(p,'VGuard/'+p.relative_to(root/'apps/vguard').as_posix()) for p in (root/'apps/vguard').rglob('*') if p.is_file() and not any(part in ['out','.local-signing','__pycache__'] for part in p.parts) and p.suffix not in ['.class','.pyc']]
files += [(root/'LICENSE','VGuard/LICENSE'),(root/'NOTICE','VGuard/NOTICE'),(root/'releases/VGuard-Setup.txt','VGuard/SETUP.txt'),(root/'releases/VGuard-Test-Report.txt','VGuard/TEST-REPORT.txt')]
write(root/'releases/VGuard-Source-GPL.zip',files)
files=[]
for directory in ['apps','web','server','tests','scripts','docs','.github','drizzle']:
    for p in (root/directory).rglob('*'):
        if p.is_file() and not any(part in ['out','.local-signing','__pycache__'] for part in p.parts) and p.suffix not in ['.class','.pyc']:
            files.append((p,'v-security-suite/'+p.relative_to(root).as_posix()))
for name in ['LICENSE','NOTICE','README.md','SECURITY.md','CONTRIBUTING.md','package.json']:
    files.append((root/name,'v-security-suite/'+name))
for name in ['VGuard-Setup.txt','VGuard-Test-Report.txt','RELEASE-NOTES.txt']:
    files.append((root/'releases'/name,'v-security-suite/releases/'+name))
write(root/'releases/V-Security-Source.zip',files)
print('Created clean GPL source archives; no signing materials or feedback records.')
