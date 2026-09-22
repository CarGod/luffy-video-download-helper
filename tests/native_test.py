import importlib.util, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('host',Path(__file__).resolve().parents[1]/'native/host.py')
host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
class HostTests(unittest.TestCase):
 def test_command_arguments(self):
  args=host.args_for({'url':'https://www.youtube.com/watch?v=test','quality':'1080','cookies':'none'})
  self.assertIn('bv*[height<=1080]+ba/b[height<=1080]',args)
  self.assertEqual(args[-2],'--')
  self.assertIn('--ignore-config',args)
  self.assertNotIn('--cookies-from-browser',args)
 def test_portrait_quality(self):
  args=host.args_for({'url':'https://x.com/name/status/1','quality':'1280'})
  self.assertIn('bv*[height<=1280]+ba/b[height<=1280]',args)
 def test_explicit_cookies(self):
  args=host.args_for({'url':'https://x.com/name/status/1','cookies':'chrome'})
  self.assertEqual(args[args.index('--cookies-from-browser')+1],'chrome')
 def test_validation(self):
  for url in ['file:///etc/passwd','https://user:pass@example.com','http://127.0.0.1/admin','http://localhost/a','--exec=oops']:
   with self.subTest(url=url),self.assertRaises(ValueError):host.validate_url(url)
  for opts in [{'quality':'1080; touch bad'},{'cookies':'chrome; echo bad'}]:
   with self.assertRaises(ValueError):host.args_for({'url':'https://example.com/a',**opts})
if __name__=='__main__':unittest.main()

class FormatTests(unittest.TestCase):
 def test_default_and_invalid_formats(self):
  self.assertEqual(host.output_format({}), 'mp4')
  with self.assertRaises(ValueError):host.output_format({'format':'mp4;rm'})
 def test_transcode_remux_and_original(self):
  import tempfile,subprocess,json
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);source=root/'input.webm'
   subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=size=160x90:rate=12','-f','lavfi','-i','sine=frequency=500','-t','1','-c:v','libvpx-vp9','-c:a','libopus',str(source)],check=True)
   events=[];original_send=host.send;host.send=events.append
   try:
    converted=host.convert_file(source,'mp4',{'cancelled':False},'test',root)
    info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(converted)]))
    self.assertEqual([s['codec_name'] for s in info['streams']],['h264','aac'])
    self.assertTrue(source.exists())
    self.assertEqual(host.convert_file(source,'original',{},'test',root),source)
    remuxed=host.convert_file(converted,'mkv',{'cancelled':False},'test',root)
    self.assertTrue(remuxed.exists());self.assertTrue(any(e['patch'].get('status')=='converting' for e in events))
   finally:host.send=original_send
