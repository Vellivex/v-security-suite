import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const script=resolve(import.meta.dirname,'../scripts/verify-vguard-payload.py');
// Fixture-only checks exercise archive handling without an SDK or signing key.
function compareScenario(scenario){
 const program=String.raw`
import importlib.util,pathlib,tempfile,zipfile,sys,json,warnings
spec=importlib.util.spec_from_file_location('payload',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
scenario=sys.argv[2]
base=[('AndroidManifest.xml',b'manifest'),('classes.dex',b'bytecode'),('resources.arsc',b'resources')]
candidate=list(base)
if scenario=='altered':candidate[1]=('classes.dex',b'bytecode changed')
elif scenario=='missing':candidate.pop()
elif scenario=='unexpected':candidate.append(('assets/injected.js',b'injected'))
elif scenario=='meta':candidate.append(('META-INF/unreviewed.txt',b'extra'))
elif scenario=='duplicate':candidate.append(('classes.dex',b'bytecode'))
elif scenario=='traversal':candidate.append(('../outside',b'extra'))
elif scenario=='absolute':candidate.append(('/absolute',b'extra'))
elif scenario=='backslash':candidate.append(('res\\outside',b'extra'))
elif scenario=='empty':candidate=[]
elif scenario=='oversized':candidate[1]=('classes.dex',b'x'*(module.MAX_ENTRY_BYTES+1))
elif scenario=='directory':candidate.append(('assets/',b''))
with tempfile.TemporaryDirectory(prefix='vguard-payload-fixture-') as directory:
 left,right=pathlib.Path(directory)/'unsigned.zip',pathlib.Path(directory)/'official.zip'
 for path,entries in [(left,base),(right,candidate)]:
  with warnings.catch_warnings():
   warnings.simplefilter('ignore',UserWarning)
   with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as archive:
    for name,data in reversed(entries) if scenario=='reordered' and path==right else entries:archive.writestr(name,data)
 try:print(json.dumps({'entries':module.compare_payloads(left,right)}))
 except (ValueError,zipfile.BadZipFile) as error:print(str(error),file=sys.stderr);sys.exit(1)
`;
 return spawnSync('python3',['-c',program,script,scenario],{encoding:'utf8'});
}
test('unsigned payload comparator accepts matching bytes independent of archive order',()=>{
 const result=compareScenario('reordered');assert.equal(result.status,0,result.stderr);assert.equal(Object.keys(JSON.parse(result.stdout).entries).length,3);
});
for(const [scenario,pattern] of [
 ['altered',/payload bytes differ/],['missing',/Missing or unexpected/],['unexpected',/Missing or unexpected/],
 ['meta',/Missing or unexpected/],['duplicate',/Duplicate APK/],['traversal',/Noncanonical APK/],
 ['absolute',/Noncanonical APK/],['backslash',/Noncanonical APK/],['empty',/Unexpected APK entry count/],
 ['oversized',/Oversized APK/],['directory',/Noncanonical APK/],
])test(`unsigned payload comparator rejects ${scenario} payload`,()=>{
 const result=compareScenario(scenario);assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,pattern);
});
