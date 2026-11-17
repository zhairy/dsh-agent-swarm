"""仅发布已固定来源和摘要的v3.4.0；不移动tag或覆盖正式资产。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

TAG = 'v3.4.0'
REPO = 'zhairy/dsh-agent-swarm'

def command(*args, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=True, timeout=180)

def git(*args):
    return command('git', *args).stdout.strip()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def load_plan():
    plan = json.loads(Path('.github/release-v3.4.0.json').read_text())
    if plan['tag'] != TAG or plan['repository'] != REPO or plan['hostVersion'] != '0.2.2-rc.3':
        raise RuntimeError('Release identity mismatch')
    if not re.fullmatch(r'[0-9a-f]{40}', plan['assetCommit']):
        raise RuntimeError('Asset commit must be immutable')
    return plan

def verify_source(plan):
    expected = plan['sourceFiles']
    actual = set(path for path in git('ls-files', '-z').split('\0') if path and not path.startswith('.github/'))
    if actual != set(expected):
        raise RuntimeError('Tag source file set changed after verification')
    for name, digest in expected.items():
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or path.is_symlink() or sha(path.read_bytes()) != digest:
            raise RuntimeError('Tag source checksum mismatch: ' + name)

def prepare(plan):
    verify_source(plan)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('asset_commit=' + plan['assetCommit'] + '\n')

def api(path, *args, check=True):
    result = command('gh', 'api', 'repos/' + REPO + '/' + path, *args, check=check)
    return json.loads(result.stdout) if result.returncode == 0 else None

def release_for_tag():
    release = api('releases/tags/' + TAG, check=False)
    if release is not None:
        return release
    # Draft可能不能由tag端点寻址，先按列表/id对账，避免重复创建。
    return next((row for row in api('releases?per_page=100') if row['tag_name'] == TAG), None)

def publish(plan, assets):
    verify_source(plan)
    if os.environ.get('GITHUB_REPOSITORY') != REPO or os.environ.get('GITHUB_REF') != 'refs/heads/main':
        raise RuntimeError('Only the authorized default branch may publish')
    commit = git('rev-parse', 'HEAD')
    if commit != os.environ['GITHUB_SHA']:
        raise RuntimeError('Checkout does not match event SHA')
    expected = plan['assets']
    files = {path.name: path for path in assets.iterdir()}
    if set(files) != set(expected):
        raise RuntimeError('Unexpected release input file set')
    for name, digest in expected.items():
        path = files[name]
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.+_-]{0,160}', name) or '..' in name or not path.is_file() or path.is_symlink() or sha(path.read_bytes()) != digest:
            raise RuntimeError('Invalid release input: ' + name)
    output = Path('publish-output')
    output.mkdir(exist_ok=True)
    for name, path in files.items():
        shutil.copyfile(path, output / name)
    summary_path = output / 'verification-summary.json'
    summary = json.loads(summary_path.read_text())
    summary.update(gitCommit=commit, sourceTree=git('rev-parse', 'HEAD^{tree}'), sourceFilesVerified=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    package = 'dsh-agent-swarm-3.4.0.tgz'
    manifest = {'schemaVersion': 1, 'package': 'dsh-agent-swarm', 'version': '3.4.0', 'gitCommit': commit, 'tag': TAG, 'sourceTree': summary['sourceTree'], 'assetSourceCommit': plan['assetCommit'], 'hostVersion': plan['hostVersion'], 'tarball': package, 'tarballSha256': sha((output / package).read_bytes()), 'stableTarball': 'dsh-agent-swarm.tgz', 'build': 'locally built exact package; tracked source hashes verified against release commit', 'assets': {path.name: sha(path.read_bytes()) for path in sorted(output.iterdir()) if path.is_file()}}
    (output / 'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    sums = {path.name: sha(path.read_bytes()) for path in sorted(output.iterdir()) if path.is_file() and path.name != 'SHA256SUMS'}
    (output / 'SHA256SUMS').write_text(''.join(digest + '  ' + name + '\n' for name, digest in sums.items()))
    # 先验证/创建精确annotated tag，已发布tag不移动。
    ref = api('git/ref/tags/' + TAG, check=False)
    if ref is None:
        tag = api('git/tags', '-X', 'POST', '-f', 'tag=' + TAG, '-f', 'message=DSH Agent Swarm v3.4.0 verified release', '-f', 'object=' + commit, '-f', 'type=commit')
        api('git/refs', '-X', 'POST', '-f', 'ref=refs/tags/' + TAG, '-f', 'sha=' + tag['sha'])
    else:
        obj = ref['object']
        if obj['type'] != 'tag':
            raise RuntimeError('Existing tag is not annotated; refusing to replace or accept it')
        target = api('git/tags/' + obj['sha'])['object']['sha']
        if target != commit:
            raise RuntimeError('Existing tag targets different source; refusing to move it')
    release = release_for_tag()
    if release is None:
        command('gh', 'release', 'create', TAG, '--repo', REPO, '--verify-tag', '--draft', '--title', 'DSH Agent Swarm v3.4.0', '--notes-file', str(output / 'RELEASE-NOTES.zh-CN.md'))
        release = release_for_tag()
        if release is None:
            raise RuntimeError('Created draft was not found by tag/list readback')
    existing = {row['name']: row for row in release['assets']}
    if set(existing) - {path.name for path in output.iterdir() if path.is_file()}:
        raise RuntimeError('Draft contains unexpected assets')
    downloads = Path('release-download-verification')
    downloads.mkdir(exist_ok=True)
    for file in sorted(output.iterdir()):
        if not file.is_file():
            continue
        if file.name not in existing:
            if not release['draft']:
                raise RuntimeError('Published release is incomplete; refusing mutation')
            command('gh', 'release', 'upload', TAG, str(file), '--repo', REPO)
        command('gh', 'release', 'download', TAG, '--repo', REPO, '--pattern', file.name, '--dir', str(downloads), '--clobber')
        if sha((downloads / file.name).read_bytes()) != sha(file.read_bytes()):
            raise RuntimeError('Uploaded/downloaded bytes mismatch: ' + file.name)
    if release['draft']:
        command('gh', 'release', 'edit', TAG, '--repo', REPO, '--draft=false', '--latest')
    final = api('releases/tags/' + TAG)
    if final['draft'] or final['prerelease'] or len(final['assets']) != len(list(output.iterdir())):
        raise RuntimeError('Release readback mismatch')
    result = {'verified': True, 'tag': TAG, 'commit': commit, 'url': final['html_url'], 'assets': len(final['assets'])}
    print(json.dumps(result))
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as report:
        report.write('v3.4.0 published and byte-verified: ' + final['html_url'] + '\n\n')
        report.write('```json\n' + json.dumps(result, indent=2) + '\n```\n')
        report.write('```text\n' + (output / 'SHA256SUMS').read_text() + '\n```\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'publish'])
    parser.add_argument('--assets', type=Path)
    args = parser.parse_args()
    plan = load_plan()
    if args.action == 'prepare':
        prepare(plan)
    else:
        if args.assets is None:
            parser.error('publish requires --assets')
        publish(plan, args.assets)
