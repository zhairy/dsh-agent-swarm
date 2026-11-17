"""发布前必须核对源码和输入；失败时不得触发GitHub写入。"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

script = Path(__file__).resolve().parents[1] / '.github/scripts/publish-v3.4.0.py'
spec = importlib.util.spec_from_file_location('release_publisher', script)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='swarm-release-publication-')
        self.cwd = Path.cwd()
        os.chdir(self.temp.name)
        subprocess.run(['git', 'init', '-q'], check=True)
        Path('source.txt').write_text('trusted\n')
        subprocess.run(['git', 'add', 'source.txt'], check=True)
        subprocess.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture'], check=True)
        self.plan = {'sourceFiles': {'source.txt': hashlib.sha256(b'trusted\n').hexdigest()}}

    def tearDown(self):
        os.chdir(self.cwd)
        self.temp.cleanup()

    def test_source_and_extra_tracked_files_fail_closed(self):
        publisher.verify_source(self.plan)
        Path('source.txt').write_text('changed')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            publisher.verify_source(self.plan)
        Path('source.txt').write_text('trusted\n')
        Path('new.txt').write_text('unreviewed')
        subprocess.run(['git', 'add', 'new.txt'], check=True)
        with self.assertRaisesRegex(RuntimeError, 'file set'):
            publisher.verify_source(self.plan)

    def test_invalid_assets_cannot_reach_github(self):
        assets = Path('assets')
        assets.mkdir()
        (assets / 'package.tgz').write_bytes(b'changed')
        self.plan['assets'] = {'package.tgz': hashlib.sha256(b'expected').hexdigest()}
        env = {'GITHUB_REPOSITORY': publisher.REPO, 'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': publisher.git('rev-parse', 'HEAD')}
        with patch.dict(os.environ, env), patch.object(publisher, 'api', side_effect=AssertionError('GitHub must not be called')):
            with self.assertRaisesRegex(RuntimeError, 'Invalid release input'):
                publisher.publish(self.plan, assets)
        self.assertFalse(Path('publish-output').exists())

    def test_version_and_immutable_asset_commit_are_required(self):
        Path('.github').mkdir()
        plan = {'tag': 'v3.4.0', 'repository': publisher.REPO, 'hostVersion': '0.2.2-rc.3', 'assetCommit': 'main'}
        Path('.github/release-v3.4.0.json').write_text(json.dumps(plan))
        with self.assertRaisesRegex(RuntimeError, 'immutable'):
            publisher.load_plan()
        plan['assetCommit'] = 'a' * 40
        Path('.github/release-v3.4.0.json').write_text(json.dumps(plan))
        self.assertEqual(publisher.load_plan()['tag'], 'v3.4.0')

    def test_lightweight_tag_cannot_be_accepted_as_annotated(self):
        assets = Path('assets')
        assets.mkdir()
        values = {'verification-summary.json': b'{}', 'dsh-agent-swarm-3.4.0.tgz': b'package', 'dsh-agent-swarm.tgz': b'package'}
        for name, value in values.items():
            (assets / name).write_bytes(value)
        self.plan.update(assets={name: hashlib.sha256(value).hexdigest() for name, value in values.items()}, hostVersion='0.2.2-rc.3', assetCommit='a' * 40)
        commit = publisher.git('rev-parse', 'HEAD')
        def remote(path, *args, **kwargs):
            self.assertEqual(path, 'git/ref/tags/v3.4.0')
            return {'object': {'type': 'commit', 'sha': commit}}
        env = {'GITHUB_REPOSITORY': publisher.REPO, 'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': commit}
        with patch.dict(os.environ, env), patch.object(publisher, 'api', side_effect=remote):
            with self.assertRaisesRegex(RuntimeError, 'annotated'):
                publisher.publish(self.plan, assets)


if __name__ == '__main__':
    unittest.main()
