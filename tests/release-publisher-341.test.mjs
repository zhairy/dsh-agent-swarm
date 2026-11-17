import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('341 发布器重建摘要时不引用旧 manifest 或旧校验和，且不发出外部写入', () => {
  const publisher = process.env.SWARM_PUBLISHER_TEST_TARGET ?? fileURLToPath(new URL('../.github/scripts/publish-v3.4.1.py', import.meta.url))
  const source = String.raw`
import hashlib, importlib.util, json, os, pathlib, tempfile, sys
spec = importlib.util.spec_from_file_location('publisher341', sys.argv[1])
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
class StopBeforeExternalWrite(Exception): pass
def no_external_write(*args, **kwargs): raise StopBeforeExternalWrite()
publisher.verify_source = lambda plan: None
publisher.api = no_external_write
commit = 'a' * 40
publisher.git = lambda *args: 'b' * 40 if args[-1].endswith('^{tree}') else commit
os.environ.update(GITHUB_REPOSITORY='zhairy/dsh-agent-swarm', GITHUB_REF='refs/heads/main', GITHUB_SHA=commit)
with tempfile.TemporaryDirectory(prefix='publisher341-') as directory:
    os.chdir(directory)
    assets = pathlib.Path('assets'); assets.mkdir()
    inputs = {
      'dsh-agent-swarm-3.4.1.tgz': b'exact fixture bytes',
      'dsh-agent-swarm.tgz': b'exact fixture bytes',
      'verification-summary.json': b'{}',
      'RELEASE-NOTES.zh-CN.md': b'verified notes',
      'release-manifest.json': b'old manifest must not appear in new digest map',
      'SHA256SUMS': b'old checksums must not appear in new digest map'
    }
    for name, data in inputs.items(): (assets / name).write_bytes(data)
    plan = {'assets': {n: publisher.sha(d) for n, d in inputs.items()}, 'assetCommit': 'c' * 40, 'hostVersion': '0.2.2-rc.3'}
    try: publisher.publish(plan, assets)
    except StopBeforeExternalWrite: pass
    else: raise AssertionError('expected stop before first GitHub API access')
    output = pathlib.Path('publish-output')
    manifest = json.loads((output / 'release-manifest.json').read_text())
    assert 'release-manifest.json' not in manifest['assets']
    assert 'SHA256SUMS' not in manifest['assets']
    assert manifest['gitCommit'] == commit
    assert manifest['assets']['verification-summary.json'] == publisher.sha((output / 'verification-summary.json').read_bytes())
    for row in (output / 'SHA256SUMS').read_text().splitlines():
        digest, name = row.split('  ', 1)
        assert name != 'SHA256SUMS'
        assert publisher.sha((output / name).read_bytes()) == digest
    assert (output / 'dsh-agent-swarm.tgz').read_bytes() == (output / 'dsh-agent-swarm-3.4.1.tgz').read_bytes()
print('publisher manifest verified without network')
`
  const result = execFileSync('python3', ['-c', source, publisher], { encoding: 'utf8', timeout: 20_000 })
  assert.match(result, /manifest verified without network/)
})
