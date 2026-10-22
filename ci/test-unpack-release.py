from unittest.mock import patch
import pathlib,importlib.util,tempfile,json,hashlib,unittest,io,tarfile
base=pathlib.Path(__file__).parent
spec=importlib.util.spec_from_file_location('package',base/'release-materials.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
spec=importlib.util.spec_from_file_location('unpack',base/'unpack-release.py');u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
class Extraction(unittest.TestCase):
 def test_checksums_provenance_and_unsafe_paths(self):
  with tempfile.TemporaryDirectory() as td:
   root=pathlib.Path(td);build=root/'build';(build/'payload').mkdir(parents=True);(build/'payload/app.js').write_bytes(b'code');env=dict(GITHUB_REPOSITORY='o/r',GITHUB_SHA='a'*40,GITHUB_REF='refs/heads/int/x',GITHUB_RUN_ID='1',GITHUB_RUN_ATTEMPT='2')
   (build/'build-manifest.json').write_text(json.dumps(dict(schema=1,repository='o/r',sourceSha='a'*40,sourceRef='refs/heads/int/x',runId='1',runAttempt='2',files=[dict(path='app.js',bytes=4,sha256=hashlib.sha256(b'code').hexdigest())])))
   sbom=root/'sbom';sbom.mkdir();(sbom/'sbom.cdx.json').write_text('{"bomFormat":"CycloneDX","components":[]}');(sbom/'sbom.spdx.json').write_text('{"spdxVersion":"SPDX-2.3"}');p.package(build,sbom,root/'release',env)
   with patch.object(pathlib.Path,'read_bytes',side_effect=AssertionError('whole archive buffering')):u.unpack(root/'release',root/'accepted',env['GITHUB_SHA'])
   assert (root/'accepted/payload/app.js').read_bytes()==b'code'
   archive=root/'release/integration-release.tar.gz';original_bytes=archive.read_bytes()
   original_tar=u.bounded_tar;passes=0
   def replace_path_between_passes(*args,**kwargs):
    nonlocal passes
    passes+=1
    if passes==2:archive.write_bytes(b'replacement bytes from candidate writer')
    return original_tar(*args,**kwargs)
   with patch.object(u,'bounded_tar',side_effect=replace_path_between_passes):
    u.unpack(root/'release',root/'snapshot-accepted',env['GITHUB_SHA'])
   assert passes==2
   assert (root/'snapshot-accepted/payload/app.js').read_bytes()==b'code'
   archive.write_bytes(original_bytes)
   with self.assertRaises(ValueError):u.unpack(root/'release',root/'bad-sha','b'*40)
   buffer=io.BytesIO()
   with tarfile.open(fileobj=buffer,mode='w:gz') as tar:
    entry=tarfile.TarInfo('../escape');entry.size=4;tar.addfile(entry,io.BytesIO(b'evil'))
   raw=buffer.getvalue();(root/'release/integration-release.tar.gz').write_bytes(raw);doc=json.loads((root/'release/artifact-provenance.json').read_text());doc['bundleSha256']=hashlib.sha256(raw).hexdigest();(root/'release/artifact-provenance.json').write_text(json.dumps(doc))
   with self.assertRaises(ValueError):u.unpack(root/'release',root/'bad-path',env['GITHUB_SHA'])
   assert not (root/'escape').exists()
 def test_budgets_reject_before_extracting_member_bytes(self):
  for limits in [dict(MAX_ARCHIVE_BYTES=1),dict(MAX_FILE_BYTES=3),dict(MAX_TOTAL_BYTES=3),dict(MAX_FILES=0),dict(MAX_RATIO=0)]:
   with self.subTest(limits=limits),tempfile.TemporaryDirectory() as td:
    root=pathlib.Path(td);archive=root/'integration-release.tar.gz'
    with tarfile.open(archive,'w:gz') as tar:
     entry=tarfile.TarInfo('payload/file');entry.size=4;tar.addfile(entry,io.BytesIO(b'code'))
    (root/'artifact-provenance.json').write_text(json.dumps(dict(sourceSha='a'*40,bundleSha256=hashlib.sha256(archive.read_bytes()).hexdigest())))
    with patch.multiple(u,**limits),patch.object(tarfile.TarFile,'extractfile',side_effect=AssertionError('payload read before budget rejection')),self.assertRaises(ValueError):u.unpack(root,root/'out','a'*40)
 def test_oversized_compressed_archive_is_rejected_before_hash_read(self):
  with tempfile.TemporaryDirectory() as td:
   root=pathlib.Path(td);(root/'integration-release.tar.gz').write_bytes(b'oversized')
   with patch.object(u,'MAX_ARCHIVE_BYTES',1),patch.object(u,'digest',side_effect=AssertionError('read before stat budget')),self.assertRaises(ValueError):u.unpack(root,root/'out','a'*40)
if __name__=='__main__':unittest.main()
