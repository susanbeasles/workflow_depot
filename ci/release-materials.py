"""Stream bounded, previously verified integration bytes; never build project code."""
import gzip,hashlib,importlib.util,io,json,os,pathlib,sys,tarfile,time
spec=importlib.util.spec_from_file_location('build_verifier',pathlib.Path(__file__).with_name('verify-build.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
MAX_ARCHIVE_BYTES=64*1024*1024
MAX_RATIO=100
MAX_SECONDS=120

def digest(path,check_time=lambda:None):
 result=hashlib.sha256()
 with path.open('rb') as stream:
  while chunk:=stream.read(1024*1024):check_time();result.update(chunk)
 return result.hexdigest()

class LimitedWriter:
 def __init__(self,stream,check_time):self.stream=stream;self.bytes=0;self.check_time=check_time
 def write(self,data):
  self.check_time()
  self.bytes+=len(data)
  if self.bytes>MAX_ARCHIVE_BYTES:raise ValueError('Release compressed archive exceeds budget')
  return self.stream.write(data)
 def flush(self):self.stream.flush()

def package(root,sbom_dir,output,env):
 started=time.monotonic()
 def check_time():
  if time.monotonic()-started>MAX_SECONDS:raise ValueError("Release time budget exceeded")
 check_time()
 root=pathlib.Path(root);sbom_dir=pathlib.Path(sbom_dir);output=pathlib.Path(output)
 manifest=v.verify(root,env,metadata_only=True)
 files=[('build-manifest.json',root/'build-manifest.json')]+[('payload/'+entry['path'],root/'payload'/entry['path']) for entry in manifest['files']]
 files += [(name,sbom_dir/name) for name in ['sbom.cdx.json','sbom.spdx.json']]
 total=0
 for name,path in files:
  check_time()
  total+=v.regular(path,v.MAX_MANIFEST_BYTES if name.startswith('sbom.') or name=='build-manifest.json' else v.MAX_FILE_BYTES)
  if total>v.MAX_TOTAL_BYTES or len(files)+1>v.MAX_FILES:raise ValueError('Release aggregate budget exceeded')
 v.verify(root,env)
 cdx=json.loads((sbom_dir/'sbom.cdx.json').read_text());spdx=json.loads((sbom_dir/'sbom.spdx.json').read_text())
 if cdx.get('bomFormat')!='CycloneDX' or not isinstance(cdx.get('components',[]),list) or not spdx.get('spdxVersion','').startswith('SPDX-'):raise ValueError('Missing or malformed build SBOM')
 check_time()
 checksum=''.join(digest(path,check_time)+'  '+name+'\n' for name,path in sorted(files)).encode()
 if total+len(checksum)>v.MAX_TOTAL_BYTES:raise ValueError('Release aggregate budget exceeded')
 output.mkdir(parents=True,exist_ok=False);archive=output/'integration-release.tar.gz'
 try:
  with archive.open('xb') as raw:
   with gzip.GzipFile(filename='',fileobj=LimitedWriter(raw,check_time),mode='wb',mtime=0) as compressed:
    with tarfile.open(fileobj=compressed,mode='w|',format=tarfile.PAX_FORMAT) as tar:
     for name,path in sorted(files+[('SHA256SUMS',None)]):
      check_time()
      info=tarfile.TarInfo(name);info.size=len(checksum) if path is None else path.stat().st_size;info.mtime=0;info.mode=0o600;info.uid=info.gid=0;info.uname=info.gname=''
      if path is None:tar.addfile(info,io.BytesIO(checksum))
      else:
       with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as stream:tar.addfile(info,stream)
  if total+len(checksum)>archive.stat().st_size*MAX_RATIO:raise ValueError('Release compression ratio exceeds budget')
  archive_digest=digest(archive,check_time)
  (output/'SHA256SUMS').write_text(archive_digest+'  integration-release.tar.gz\n')
  (output/'artifact-provenance.json').write_text(json.dumps({**{k:manifest[k] for k in ['repository','sourceSha','sourceRef','runId','runAttempt']},'schema':'workflow-depot-artifact-inventory/v1','bundleSha256':archive_digest,'buildManifestSha256':digest(root/'build-manifest.json',check_time)},sort_keys=True)+'\n')
 except BaseException:
  archive.unlink(missing_ok=True);raise
if __name__=='__main__':package(*sys.argv[1:4],os.environ)
