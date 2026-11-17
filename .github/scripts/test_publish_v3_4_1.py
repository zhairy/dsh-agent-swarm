"""发布载荷目录回归：保留严格文件集，测试过程禁止任何外部写入。"""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
WORKFLOW = SCRIPTS.parent / 'workflows' / 'release-v3.4.1.yml'

class StopBeforeRemote(Exception):
    pass

class PayloadDirectoryTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('publisher341', SCRIPTS / 'publish-v3.4.1.py')
        self.publisher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.publisher)
        self.publisher.verify_source = lambda plan: None
        self.publisher.api = self.no_remote
        self.publisher.git = lambda *args: 'b' * 40 if args[-1].endswith('^{tree}') else 'a' * 40
        self.old_cwd = Path.cwd()
        self.old_environment = {key: os.environ.get(key) for key in ['GITHUB_REPOSITORY', 'GITHUB_REF', 'GITHUB_SHA']}
        os.environ.update(GITHUB_REPOSITORY='zhairy/dsh-agent-swarm', GITHUB_REF='refs/heads/main', GITHUB_SHA='a' * 40)
        self.temporary = tempfile.TemporaryDirectory(prefix='swarm341-payload-')
        os.chdir(self.temporary.name)
        self.checkout = Path('release-assets')
        (self.checkout / 'assets/screenshots').mkdir(parents=True)
        (self.checkout / 'assets/screenshots/source-only.txt').write_text('existing source asset')
        self.payload = self.checkout / 'release-payload/v3.4.1'
        self.payload.mkdir(parents=True)
        inputs = {'dsh-agent-swarm-3.4.1.tgz': b'exact package', 'dsh-agent-swarm.tgz': b'exact package', 'verification-summary.json': b'{}', 'RELEASE-NOTES.zh-CN.md': b'notes'}
        for name, data in inputs.items(): (self.payload / name).write_bytes(data)
        self.plan = {'assetCommit': 'c' * 40, 'hostVersion': '0.2.2-rc.3', 'assets': {name: self.publisher.sha(data) for name, data in inputs.items()}}

    def tearDown(self):
        os.chdir(self.old_cwd)
        self.temporary.cleanup()
        for key, value in self.old_environment.items():
            if value is None: os.environ.pop(key, None)
            else: os.environ[key] = value

    @staticmethod
    def no_remote(*args, **kwargs):
        raise StopBeforeRemote()

    def configured_directory(self):
        lines = [line.strip().split('run:', 1)[1].strip() for line in WORKFLOW.read_text().splitlines() if 'run:' in line and 'publish-v3.4.1.py publish --assets' in line]
        self.assertEqual(len(lines), 1)
        argv = shlex.split(lines[0])
        return Path(argv[argv.index('--assets') + 1])

    def test_workflow_selects_complete_dedicated_payload(self):
        with self.assertRaises(StopBeforeRemote):
            self.publisher.publish(self.plan, self.configured_directory())
        self.assertTrue((Path('publish-output') / 'SHA256SUMS').is_file())
        self.assertTrue((self.checkout / 'assets/screenshots/source-only.txt').is_file())

    def test_unexpected_payload_directory_still_rejected(self):
        (self.payload / 'unexpected').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'Unexpected release input file set'):
            self.publisher.publish(self.plan, self.payload)

if __name__ == '__main__':
    unittest.main()
