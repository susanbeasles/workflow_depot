"""Synthetic regressions for cache verification and bounded compressed asset parsing."""
import base64, gzip, hashlib, importlib.util, io, json, os, pathlib, tempfile, unittest, zipfile
from unittest.mock import patch
SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / '.github/scripts'
def load(name):
 spec=importlib.util.spec_from_file_location(name,SCRIPTS/(name+'.py')); module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
cache=load('cache_inspect');asset=load('asset_scan')
class CacheAssetMediums(unittest.TestCase):
 def wheel(self,digest,record_extra='',content=b'payload'):
  data=io.BytesIO()
  with zipfile.ZipFile(data,'w') as out:
   out.writestr('pkg/data',content)
   out.writestr('pkg-1.dist-info/RECORD',f'pkg/data,{digest},{len(content)}\npkg-1.dist-info/RECORD,,\n'+record_extra)
  findings=cache.F();cache.walk_zip(data.getvalue(),'pkg.whl',findings,'wheel');return findings.items
 def test_wheel_rejects_unsupported_malformed_missing_and_weak_digests(self):
  for digest in ['unknown=AA','sha256','sha256=***','sha256=AA','sha1='+base64.urlsafe_b64encode(hashlib.sha1(b'payload').digest()).decode().rstrip('='),'']:
   with self.subTest(digest=digest):
    items=self.wheel(digest)
    self.assertTrue(any(i['rule']=='WHEEL-RECORD-INVALID' and i['severity'] in {'high','critical'} for i in items),items)
 def test_wheel_valid_hash_and_mismatch(self):
  digest='sha256='+base64.urlsafe_b64encode(hashlib.sha256(b'payload').digest()).decode().rstrip('=')
  self.assertEqual(self.wheel(digest),[])
  self.assertTrue(any(i['rule']=='WHEEL-RECORD-MISMATCH' for i in self.wheel(digest,content=b'changed')))
 def test_cache_symlink_prefix_and_indirect_escape(self):
  with tempfile.TemporaryDirectory() as temp:
   base=pathlib.Path(temp);root=base/'cache';root.mkdir();other=base/'cache-evil';other.mkdir();(other/'payload').write_text('x');(root/'safe').write_text('x')
   cache.ROOT=str(root)
   for target in [str(other/'payload'),'../cache-evil/payload']:
    link=root/'link';link.symlink_to(target);findings=cache.F();cache.inspect_file(str(link),'link',findings,'generic');self.assertTrue(any(i['rule']=='SYMLINK-ESCAPE' for i in findings.items));link.unlink()
   (root/'alias').symlink_to(other,target_is_directory=True);(root/'link').symlink_to('alias/payload');findings=cache.F();cache.inspect_file(str(root/'link'),'link',findings,'generic');self.assertTrue(any(i['rule']=='SYMLINK-ESCAPE' for i in findings.items))
   (root/'inside').symlink_to('safe');findings=cache.F();cache.inspect_file(str(root/'inside'),'inside',findings,'generic');self.assertEqual(findings.items,[])
 def test_node_bin_symlink_uses_canonical_boundary(self):
  with tempfile.TemporaryDirectory() as temp:
   base=pathlib.Path(temp);root=base/'node_modules';(root/'.bin').mkdir(parents=True);other=base/'node_modules-evil';other.mkdir();(other/'payload').write_text('x');(root/'.bin/cmd').symlink_to(other/'payload');findings=cache.F();cache.node_modules(str(root),'',findings);self.assertTrue(any(i['rule']=='NODE_MODULES-BIN-ESCAPE' for i in findings.items))
 def test_svgz_bounded_decompression_and_active_content(self):
  with tempfile.TemporaryDirectory() as temp:
   path=pathlib.Path(temp)/'asset.svgz';path.write_bytes(gzip.compress(b'<svg><script>alert(1)</script></svg>'))
   with patch('gzip.decompress',side_effect=AssertionError('unbounded decompression forbidden')):
    findings=asset.Findings();asset.scan_file(str(path),'asset.svgz',findings,1024);self.assertTrue(any(i['rule']=='SVG-SCRIPT' for i in findings.items),findings.items)
    path.write_bytes(gzip.compress(b'x'*100000));findings=asset.Findings();asset.scan_file(str(path),'asset.svgz',findings,1024);self.assertTrue(any(i['rule']=='SVGZ-DECOMPRESSION-RATIO' for i in findings.items),findings.items)
 def test_svgz_inflation_requests_a_bounded_output_buffer(self):
  original=gzip.GzipFile.read;requests=[]
  def bounded_read(stream,size=-1):
   requests.append(size);self.assertGreater(size,0);self.assertLessEqual(size,4097);return original(stream,size)
  with tempfile.TemporaryDirectory() as temp:
   path=pathlib.Path(temp)/'asset.svgz';path.write_bytes(gzip.compress(b'x'*100000))
   with patch.object(gzip.GzipFile,'read',bounded_read):
    findings=asset.Findings();asset.scan_file(str(path),'asset.svgz',findings,1024)
   self.assertEqual(requests,[4097]);self.assertTrue(any(i['rule']=='SVGZ-DECOMPRESSION-RATIO' for i in findings.items))
 def test_svgz_truncated_input_fails_closed(self):
  with tempfile.TemporaryDirectory() as temp:
   path=pathlib.Path(temp)/'asset.svgz';path.write_bytes(gzip.compress(b'<svg/>')[:-5]);findings=asset.Findings();asset.scan_file(str(path),'asset.svgz',findings,1024);self.assertTrue(any(i['rule']=='SVGZ-MALFORMED' and i['severity'] in {'high','critical'} for i in findings.items),findings.items)
if __name__=='__main__':unittest.main()
