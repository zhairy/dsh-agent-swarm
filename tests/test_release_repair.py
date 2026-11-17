"""发布修复必须拒绝未知前像，且不能在替代字节验证前删除原件。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('repair', ROOT / '.github/scripts/repair-v3.4.0.py')
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class RepairTests(unittest.TestCase):
    def test_unknown_preimage_and_duplicates_refused(self):
        good = repair.publisher.sha(b'old')
        with patch.object(repair, 'download', return_value=b'foreign'):
            with self.assertRaisesRegex(RuntimeError, 'Unexpected'):
                repair.validate_state([dict(name='x')], {'x': good}, {'x': good})
        with patch.object(repair, 'download', return_value=b'old'):
            with self.assertRaisesRegex(RuntimeError, 'Duplicate'):
                repair.validate_state([dict(name='x'), dict(name='x')], {'x': good}, {'x': good})

    def test_interrupted_promotion_accepts_only_matching_stage(self):
        digest = repair.publisher.sha(b'new')
        with patch.object(repair, 'download', return_value=b'new'):
            repair.validate_state([dict(name=repair.PREFIX + 'x')], {'x': '0' * 64}, {'x': digest})
            with self.assertRaisesRegex(RuntimeError, 'Missing canonical'):
                repair.validate_state([], {'x': '0' * 64}, {'x': digest})

    def test_stage_transfer_failure_never_deletes_original(self):
        plan = dict(assets={'x': 'digest'}, beforeAssets={'x': 'digest'}, releaseId=448013183)
        calls = []
        def rest(path, method='GET', **fields):
            calls.append(method)
            return dict(tag_name='v3.4.0', draft=False, prerelease=False, assets=[dict(name='x', id=1)])
        env = dict(GITHUB_REPOSITORY=repair.REPO, GITHUB_REF='refs/heads/main', GITHUB_SHA='commit')
        with patch.dict(repair.os.environ, env), patch.object(repair.publisher, 'git', return_value='commit'), patch.object(repair, 'outputs', return_value={'x': b'new'}), patch.object(repair, 'validate_tag'), patch.object(repair, 'validate_state'), patch.object(repair, 'rest', side_effect=rest), patch.object(repair, 'download', return_value=b'old'), patch.object(repair.publisher, 'asset_request', side_effect=RuntimeError('transfer failure')):
            with self.assertRaisesRegex(RuntimeError, 'transfer failure'):
                repair.publish(plan, Path('.'))
        self.assertEqual(calls, ['GET'])

    def test_changed_tag_refused(self):
        plan = dict(tagObject='expected', releaseCommit='source')
        with patch.object(repair, 'rest', return_value={'object': {'type': 'tag', 'sha': 'foreign'}}):
            with self.assertRaisesRegex(RuntimeError, 'tag changed'):
                repair.validate_tag(plan)

    def test_outputs_bind_product_and_repair_separately(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            values = {'verification-summary.json': b'{}', 'dsh-agent-swarm-3.4.0.tgz': b'core'}
            for name, data in values.items():
                (root / name).write_bytes(data)
            plan = dict(assets={n: repair.publisher.sha(v) for n, v in values.items()}, releaseCommit='product', sourceTree='tree', assetCommit='inputs')
            files = repair.outputs(plan, root, 'repair-source')
            manifest = json.loads(files['release-manifest.json'])
            self.assertEqual(manifest['gitCommit'], 'product')
            self.assertEqual(manifest['compatibilityRepair']['sourceCommit'], 'repair-source')
            self.assertEqual(files['dsh-agent-swarm-3.4.0.tgz'], b'core')
            self.assertIn(repair.publisher.sha(files['release-manifest.json']), files['SHA256SUMS'].decode())
            (root / 'unexpected').write_text('bad')
            with self.assertRaisesRegex(RuntimeError, 'file set'):
                repair.outputs(plan, root, 'repair-source')


if __name__ == '__main__':
    unittest.main()
