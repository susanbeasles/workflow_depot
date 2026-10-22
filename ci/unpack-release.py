"""Two-pass bounded streaming extraction after signature verification."""
import gzip
from contextlib import contextmanager
import hashlib,json,os,pathlib,re,shutil,stat,sys,tarfile,tempfile
MAX_ARCHIVE_BYTES=64*1024*1024
MAX_FILE_BYTES=64*1024*1024
MAX_TOTAL_BYTES=256*1024*1024
MAX_FILES=4096
MAX_RATIO=100
MAX_JSON_BYTES=4*1024*1024

def digest(path):
 result=hashlib.sha256()
 path.seek(0)
 while chunk:=path.read(1024*1024):result.update(chunk)
 return result.hexdigest()

def regular(path,limit):
 info=path.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_size>limit:raise ValueError('Release file exceeds budget or is unsafe')
 return info.st_size

@contextmanager
def bounded_tar(archive,compressed):
 class Reader:
  used=0
  def read(self,size):
   if size<0 or size>MAX_FILE_BYTES:raise ValueError('Release parser read exceeds budget')
   # Include headers/padding in the expanded stream bound, not only declared payload.
   maximum=min(MAX_TOTAL_BYTES,compressed*MAX_RATIO)
   data=stream.read(min(size,maximum-self.used+1));self.used+=len(data)
   if self.used>maximum:raise ValueError('Release expanded stream or ratio exceeds budget')
   return data
 archive.seek(0)
 with gzip.GzipFile(fileobj=archive,mode='rb') as stream:
  with tarfile.open(fileobj=Reader(),mode='r|') as tar:yield tar

def _unpack_snapshot(source,destination,expected_sha,archive):
 source=pathlib.Path(source);destination=pathlib.Path(destination)
 compressed=os.fstat(archive.fileno()).st_size
 regular(source/'artifact-provenance.json',MAX_JSON_BYTES)
 provenance=json.loads((source/'artifact-provenance.json').read_text())
 if provenance.get('sourceSha')!=expected_sha or provenance.get('bundleSha256')!=digest(archive):raise ValueError('Signed release provenance differs')
 inventory={};size=0
 # Header-only preflight: no extracted payload or aggregate in-memory byte buffers.
 with bounded_tar(archive,compressed) as tar:
  for entry in tar:
   if not entry.isfile() or entry.name in inventory or entry.name.startswith('/') or '\\' in entry.name or any(p in ['..','.',''] for p in entry.name.split('/')):raise ValueError('Unsafe release archive')
   size+=entry.size
   if entry.size>MAX_FILE_BYTES or size>MAX_TOTAL_BYTES or len(inventory)>=MAX_FILES or size>compressed*MAX_RATIO:raise ValueError('Release extraction budget exceeded')
   if entry.name in ['SHA256SUMS','build-manifest.json'] and entry.size>MAX_JSON_BYTES:raise ValueError('Release metadata budget exceeded')
   inventory[entry.name]=entry.size
 if not {'SHA256SUMS','build-manifest.json'}<=inventory.keys():raise ValueError('Missing release metadata')
 destination.parent.mkdir(parents=True,exist_ok=True)
 with tempfile.TemporaryDirectory(prefix='.release-verified-',dir=destination.parent) as td:
  staging=pathlib.Path(td);actual={}
  with bounded_tar(archive,compressed) as tar:
   for entry in tar:
    if inventory.get(entry.name)!=entry.size or not entry.isfile():raise ValueError('Release changed after preflight')
    path=staging/entry.name;path.parent.mkdir(parents=True,exist_ok=True);result=hashlib.sha256();read=0
    with tar.extractfile(entry) as stream,path.open('xb') as output:
     while chunk:=stream.read(min(1024*1024,entry.size-read+1)):
      read+=len(chunk)
      if read>entry.size:raise ValueError('Release entry grew')
      output.write(chunk);result.update(chunk)
    if read!=entry.size:raise ValueError('Truncated release entry')
    actual[entry.name]=result.hexdigest()
  if actual['build-manifest.json']!=provenance['buildManifestSha256']:raise ValueError('Manifest digest differs')
  expected={}
  for line in (staging/'SHA256SUMS').read_text().splitlines():
   checksum,name=line.split('  ',1)
   if not re.fullmatch('[a-f0-9]{64}',checksum) or name in expected:raise ValueError('Invalid checksum inventory')
   expected[name]=checksum
  actual.pop('SHA256SUMS')
  if not actual or expected!=actual:raise ValueError('Release checksum inventory differs')
  if destination.exists() or destination.is_symlink():raise ValueError('Release destination already exists')
  os.rename(staging,destination)
 return provenance
def unpack(source,destination,expected_sha):
 # Copy once into an unlinked private descriptor, then authenticate and parse
 # precisely those bytes. Path replacements and same-inode writers cannot alter
 # the authenticated snapshot between preflight and extraction.
 path=pathlib.Path(source)/'integration-release.tar.gz'
 with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as original,tempfile.TemporaryFile() as snapshot:
  info=os.fstat(original.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_size>MAX_ARCHIVE_BYTES:raise ValueError('Unsafe or oversized release archive')
  copied=0
  while chunk:=original.read(min(1024*1024,MAX_ARCHIVE_BYTES-copied+1)):
   copied+=len(chunk)
   if copied>MAX_ARCHIVE_BYTES:raise ValueError('Release archive grew')
   snapshot.write(chunk)
  snapshot.flush()
  return _unpack_snapshot(source,destination,expected_sha,snapshot)

if __name__=='__main__':unpack(sys.argv[1],sys.argv[2],os.environ['GITHUB_SHA'])
