"""草稿恢复只按身份读取；HTTP token不得流向重定向主机。"""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

path = Path(__file__).resolve().parents[1] / 'scripts/publish-v3.4.0.py'
spec = importlib.util.spec_from_file_location('publication_recovery', path)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class RecoveryTests(unittest.TestCase):
    def test_unique_untagged_draft_is_recovered_by_title_and_target(self):
        draft = {'id': 12, 'tag_name': 'untagged-fixture', 'name': 'DSH Agent Swarm v3.4.0', 'draft': True, 'target_commitish': 'main'}
        with patch.object(publisher, 'api', side_effect=[None, [draft]]) as remote:
            self.assertEqual(publisher.release_for_tag('a' * 40)['id'], 12)
            self.assertEqual(remote.call_count, 2)
        with patch.object(publisher, 'api', side_effect=[None, [draft, dict(draft, id=13)]]):
            with self.assertRaisesRegex(RuntimeError, 'Ambiguous'):
                publisher.release_for_tag('a' * 40)

    def test_graphql_id_fallback_is_confirmed_by_rest(self):
        import json
        node = {'databaseId': 12, 'name': 'DSH Agent Swarm v3.4.0', 'isDraft': True}
        graph = {'data': {'repository': {'releases': {'nodes': [node]}}}}
        draft = {'id': 12, 'draft': True, 'target_commitish': 'main'}
        result = subprocess.CompletedProcess([], 0, json.dumps(graph), '')
        with patch.object(publisher, 'api', side_effect=[None, [], draft]), patch.object(publisher, 'command', return_value=result):
            self.assertEqual(publisher.release_for_tag('a' * 40)['id'], 12)

    def test_cross_host_redirect_strips_auth_and_rejects_unknown_hosts(self):
        request = urllib.request.Request('https://api.github.com/repos/fixture/assets/1', headers={'Authorization': 'Bearer fixture-only'})
        handler = publisher.ReleaseRedirect()
        moved = handler.redirect_request(request, None, 302, 'Found', {}, 'https://release-assets.githubusercontent.com/fixture')
        self.assertIsNone(moved.get_header('Authorization'))
        with self.assertRaisesRegex(RuntimeError, 'redirect host'):
            handler.redirect_request(request, None, 302, 'Found', {}, 'https://untrusted.invalid/file')

    def test_asset_request_rejects_external_targets_without_reading_token(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'Untrusted'):
                publisher.asset_request('https://untrusted.invalid/assets')

    def test_pinned_source_revision_is_checked_independently_of_automation(self):
        with tempfile.TemporaryDirectory(prefix='swarm-publication-recovery-') as folder:
            old = Path.cwd()
            try:
                os.chdir(folder)
                subprocess.run(['git', 'init', '-q'], check=True)
                Path('product.txt').write_text('product\n')
                subprocess.run(['git', 'add', 'product.txt'], check=True)
                subprocess.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'product'], check=True)
                commit = publisher.git('rev-parse', 'HEAD')
                plan = {'sourceFiles': {'product.txt': publisher.sha(b'product\n')}}
                original_command = publisher.command
                def local_command(*args, **kwargs):
                    if args[:2] == ('git', 'fetch'):
                        return subprocess.CompletedProcess(args, 0, '', '')
                    return original_command(*args, **kwargs)
                with patch.object(publisher, 'command', side_effect=local_command):
                    publisher.verify_revision(plan, commit)
                    plan['sourceFiles']['product.txt'] = publisher.sha(b'wrong\n')
                    with self.assertRaisesRegex(RuntimeError, 'checksum'):
                        publisher.verify_revision(plan, commit)
            finally:
                os.chdir(old)


if __name__ == '__main__':
    unittest.main()
