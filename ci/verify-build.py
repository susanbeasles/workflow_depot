"""Verify bounded downloaded integration artifact before scanners consume it."""
import hashlib,json,os,pathlib,re,stat,sys,time
MAX_MANIFEST_BYTES=4*1024*1024
MAX_FILES=4096
MAX_ENTRIES=8192
MAX_FILE_BYTES=64*1024*1024
MAX_TOTAL_BYTES=256*1024*1024
MAX_SECONDS=120

def regular(path,limit):
 info=path.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_size>limit:raise ValueError('Unsafe or oversized build file')
 return info.st_size

def verify(root,env,metadata_only=False):
 started=time.monotonic()
 def check_time():
  if time.monotonic()-started>MAX_SECONDS:raise ValueError("Build time budget exceeded")
 root=pathlib.Path(root)
 check_time()
 if root.is_symlink() or not root.is_dir():raise ValueError('Unsafe build root')
 regular(root/'build-manifest.json',MAX_MANIFEST_BYTES)
 manifest=json.loads((root/'build-manifest.json').read_text())
 for key,expected in [('schema',1),('repository',env['GITHUB_REPOSITORY']),('sourceSha',env['GITHUB_SHA']),('sourceRef',env['GITHUB_REF']),('runId',env['GITHUB_RUN_ID']),('runAttempt',env['GITHUB_RUN_ATTEMPT'])]:
  if manifest.get(key)!=expected:raise ValueError('Build identity mismatch: '+key)
 entries=manifest.get('files')
 if not isinstance(entries,list) or not 0<len(entries)<=MAX_FILES:raise ValueError('Build file count exceeds budget')
 expected={};total=0
 for entry in entries:
  check_time()
  name=entry['path'];size=entry['bytes']
  if not isinstance(name,str) or not name or '\\' in name or name.startswith('/') or any(p in ['.','..',''] for p in name.split('/')) or name in expected:raise ValueError('Unsafe or duplicate manifest entry')
  if not re.fullmatch('[a-f0-9]{64}',entry['sha256']):raise ValueError('Invalid digest')
  if type(size) is not int or not 0<=size<=MAX_FILE_BYTES:raise ValueError('Build member exceeds budget')
  total+=size
  if total>MAX_TOTAL_BYTES:raise ValueError('Build total exceeds budget')
  expected[name]={'bytes':size,'sha256':entry['sha256']}
 payload=root/'payload'
 if payload.is_symlink() or not payload.is_dir():raise ValueError('Unsafe build payload')
 # Complete bounded metadata preflight before reading any payload bytes. No archives are
 # decompressed here: expanded-byte budgets also bound highly compressible downloaded files.
 paths=[];count=0;total=0
 pending=[payload]
 while pending:
  with os.scandir(pending.pop()) as children:
   for child in children:
    check_time()
    count+=1
    if count>MAX_ENTRIES:raise ValueError('Build entry count exceeds budget')
    path=pathlib.Path(child.path);info=child.stat(follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
     pending.append(path);continue
    if not stat.S_ISREG(info.st_mode) or info.st_size>MAX_FILE_BYTES:raise ValueError('Unsafe or oversized build entry')
    total+=info.st_size
    if len(paths)>=MAX_FILES or total>MAX_TOTAL_BYTES:raise ValueError('Build aggregate exceeds budget')
    relative=path.relative_to(payload).as_posix()
    if relative not in expected or expected[relative]['bytes']!=info.st_size:raise ValueError('Build inventory mismatch')
    paths.append((relative,path,info.st_size))
 if len(paths)!=len(expected):raise ValueError('Build inventory mismatch')
 names=set()
 with os.scandir(root) as children:
  for child in children:
   check_time()
   names.add(child.name)
   if len(names)>2:raise ValueError('Unexpected bundle entries')
 if names!={'payload','build-manifest.json'}:raise ValueError('Unexpected bundle entries')
 if metadata_only:return manifest
 for name,path,size in paths:
  check_time()
  digest=hashlib.sha256();read=0
  with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb') as stream:
   if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):raise ValueError('Unsafe opened build file')
   while chunk:=stream.read(min(1024*1024,size-read+1)):
    check_time()
    read+=len(chunk)
    if read>size:raise ValueError('Build bytes grew after preflight')
    digest.update(chunk)
  if read!=size or digest.hexdigest()!=expected[name]['sha256']:raise ValueError('Build bytes do not match manifest')
 return manifest
if __name__=='__main__':
 verify(sys.argv[1],os.environ);print('Verified bounded integration artifact identity and bytes.')
